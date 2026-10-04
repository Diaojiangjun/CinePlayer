/**
 * 内容缓存端到端验证
 *
 * 要回答的问题只有一个：**「不再每次重新加载」是不是真的？**
 * 做法是在本机起一个桩采集站，逐条统计收到的请求数，然后驱动真实应用：
 *
 *   1. 首次浏览分类           → 采集站收到 1 次列表请求
 *   2. 列表接口不带封面时      → 自动按 id 批量补一次，卡片显示真实封面
 *   3. 点击别的分类            → 内容真的切换（而不是只有高亮变了）
 *   4. 切到别的页面再回来      → 仍是 1 次（命中缓存，界面直接出内容）
 *   5. 打开影片详情再返回重开  → 详情只请求 1 次
 *   6. 关掉应用重新启动        → 列表 / 详情 / 节目单 / 封面全都还是原次数（缓存落库生效）
 *   7. 点「刷新」              → 对应接口请求数 +1（只有手动刷新才回源）
 *
 * 桩站刻意返回 `Cache-Control: no-store`，让 Chromium 自带的 HTTP 缓存无法介入 ——
 * 这样「没有产生请求」只可能来自应用自己的内容缓存，结论才站得住。
 *
 * 桩站还刻意模仿真实采集站：`ac=list` **不返回 `vod_pic`**（只有 `ac=detail` 才带），
 * 因为「列表没有封面」正是线上站点的常态，也正是这条链路最容易退化回去的地方。
 *
 * 数据安全：应用以 `--user-data-dir` 指向 .smoke 下的独立目录启动，
 * 绝不读写用户真实的媒体库 / 播放历史 / 内容源。
 *
 * 运行：node scripts/smoke-cache.mjs
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\\/g, '/').replace(/\/$/, '')
const PORT = 8790
const CDP_PORT = 9224
/**
 * 每次运行都用全新的 userData 目录。
 *
 * 早期版本复用同一个目录并在启动前 rmSync 删除 —— 但 Windows 上 IndexedDB 的
 * LevelDB 文件常残留锁定，删除会静默失败，于是第二次运行直接命中上一次的缓存，
 * 「首次浏览应当产生一次请求」的断言就假失败了。换成唯一目录后，
 * 冷启动语义是构造出来的，不再依赖文件系统能否删干净。
 */
const RUN_ID = `${Date.now().toString(36)}-${process.pid.toString(36)}`
const USER_DATA = `${ROOT}/.smoke/userdata-cache-${RUN_ID}`
const BASE = `http://127.0.0.1:${PORT}`
const API_URL = `${BASE}/api.php/provide/vod/`
const EPG_URL = `${BASE}/epg.xml`

const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

/* ------------------------------------------------------------------ *
 * 1. 桩采集站：返回标准苹果CMS XML，并统计请求数
 * ------------------------------------------------------------------ */

const counts = { list: 0, detail: 0, pics: 0, epg: 0, other: 0 }

/** 1×1 PNG：让卡片里的 <img> 真的能解码，从而能断言 naturalWidth > 0 */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
)

/**
 * 分类不同，返回的片名前缀也不同 —— 这样「点击分类有没有真的生效」是可断言的。
 *
 * 注意 `1` 对应**父分类「电影片」**，前缀是空串：真实采集站的父分类
 * 往往只是分组标题，按父 id 过滤会返回 0 条。这里刻意模仿这个缺陷，
 * 好让「点了父分类只看到一片空白」这种体验不可能再悄悄回归。
 */
const CATEGORY_PREFIX = { '': '全部影片', 1: '', 2: '动作影片', 3: '喜剧影片' }

/**
 * 刻意超长的片名（真实站点里很常见）。
 *
 * 它是一条布局用例的靶子：卡片标题如果 `nowrap`，网格项会被撑得比自己的轨道还宽，
 * 标题就会压到隔壁卡片上 —— 用户看到的正是「影视名超过了挤在一起」。
 */
const LONG_NAME = '物产展之女~北盐原村·磐梯高原~炼狱的妹妹病态漫画'

/**
 * 备注基线。
 *
 * 刻意写成**能被解析出集数**的形态（真实采集站最常见的就是「更新至N集」）：
 * 「同步追剧」判断有没有新集，靠的正是这个数字。
 * 写死成 `HD` 的话，这条链路永远测不到。
 */
const NOTE_BASE = '更新至12集'
const NOTE_UPDATED = '更新至14集'

/** 每部影片的备注覆写，用来模拟「站点后来更新了」 */
const NOTE_BY_ID = new Map()

function noteOf(id) {
  return NOTE_BY_ID.get(String(id)) ?? NOTE_BASE
}

function vodName(index, prefix) {
  return index === 3 ? LONG_NAME : `${prefix}${index}`
}

/** 分类表：电影片(1) 是父节点，动作片(2)/喜剧片(3) 是它的子节点 */
const CLASS_XML =
  '<class><ty id="1" pid="0">电影片</ty><ty id="2" pid="1">动作片</ty><ty id="3" pid="1">喜剧片</ty></class>'

/**
 * 一条影片记录。
 *
 * `withPic` 默认 false：真实采集站的 `ac=list` 就长这样 —— 只有 id / 名称 / 分类 / 备注，
 * **没有 `vod_pic`**。封面只有详情接口才带。
 */
function vodXml(id, name, withPic = false) {
  return (
    `<video><id>${id}</id><tid>1</tid><name>${name}</name><type>动作片</type>` +
    (withPic ? `<pic>${BASE}/poster/${id}.png</pic>` : '') +
    `<lang>国语</lang><area>大陆</area><year>2026</year><state>0</state><note>${noteOf(id)}</note>` +
    `<actor>演员甲</actor><director>导演乙</director><score>8.6</score>` +
    `<des><![CDATA[<p>第 ${id} 部测试影片的简介，用于验证详情解析。</p>]]></des>` +
    `<total>12</total><serial>12</serial>` +
    `<dl>` +
    `<dd flag="线路一">第1集$https://cdn.example.com/${id}/1.m3u8#第2集$https://cdn.example.com/${id}/2.m3u8</dd>` +
    `<dd flag="线路二">第1集$https://cdn.example.com/${id}-b/1.m3u8</dd>` +
    `</dl></video>`
  )
}

function listXml(page, typeId = '') {
  const prefix = CATEGORY_PREFIX[typeId] ?? CATEGORY_PREFIX['']
  // 父分类：真实站点就是返回 0 条 —— 用来验证客户端的自动兜底
  if (!prefix) {
    return `<?xml version="1.0" encoding="utf-8"?><rss version="5.1"><list page="1" pagecount="1" pagesize="20" recordcount="0"></list>${CLASS_XML}</rss>`
  }
  const start = (page - 1) * 20
  const vods = Array.from({ length: 20 }, (_, i) =>
    vodXml(start + i + 1, vodName(start + i + 1, prefix))
  ).join('')
  return `<?xml version="1.0" encoding="utf-8"?><rss version="5.1"><list page="${page}" pagecount="3" pagesize="20" recordcount="60">${vods}</list>${CLASS_XML}</rss>`
}

/** 详情：带封面、带播放线路 */
function detailXml(id, withPic = true) {
  return `<?xml version="1.0" encoding="utf-8"?><rss version="5.1"><list page="1" pagecount="1" pagesize="1" recordcount="1">${vodXml(id, `测试影片${id}`, withPic)}</list>${CLASS_XML}</rss>`
}

/** 批量补封面：`ac=detail&ids=1,2,3…` */
function picsXml(ids) {
  const vods = ids.map((id) => vodXml(id, `测试影片${id}`, true)).join('')
  return `<?xml version="1.0" encoding="utf-8"?><rss version="5.1"><list page="1" pagecount="1" pagesize="${ids.length}" recordcount="${ids.length}">${vods}</list>${CLASS_XML}</rss>`
}

const pad = (n) => String(n).padStart(2, '0')
const stamp = (offsetMinutes) => {
  const d = new Date(Date.now() + offsetMinutes * 60 * 1000)
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00 +0000`
}

const EPG_XML = `<?xml version="1.0" encoding="UTF-8"?>
<tv generator-info-name="smoke-cache">
  <channel id="cctv1"><display-name>CCTV-1 综合</display-name></channel>
  <channel id="cctv2"><display-name>CCTV-2 财经</display-name></channel>
  <programme start="${stamp(-30)}" stop="${stamp(30)}" channel="cctv1">
    <title lang="zh">新闻联播</title><desc>测试节目一</desc>
  </programme>
  <programme start="${stamp(30)}" stop="${stamp(90)}" channel="cctv1">
    <title lang="zh">焦点访谈</title>
  </programme>
  <programme start="${stamp(-10)}" stop="${stamp(50)}" channel="cctv2">
    <title lang="zh">经济半小时</title>
  </programme>
</tv>`

const server = createServer((req, res) => {
  const url = new URL(req.url || '/', BASE)
  const send = (body, type) => {
    res.writeHead(200, {
      'Content-Type': type,
      // 关键：让 Chromium 的 HTTP 缓存彻底失效，
      // 于是「没有产生请求」只可能来自应用自身的内容缓存
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      Pragma: 'no-cache',
      Expires: '0'
    })
    res.end(body)
  }

  if (url.pathname === '/__stats') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(counts))
    return
  }

  if (url.pathname === '/__reset') {
    counts.list = counts.detail = counts.pics = counts.epg = counts.other = 0
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(counts))
    return
  }

  // 覆写某部影片的备注：用来模拟「采集站后来更新了集数」。
  // 不计数，它不是被测链路的一部分。
  if (url.pathname === '/__note') {
    const id = url.searchParams.get('id') ?? ''
    const value = url.searchParams.get('value') ?? ''
    if (value) NOTE_BY_ID.set(id, value)
    else NOTE_BY_ID.delete(id)
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify({ id, value }))
    return
  }

  // 封面图床：必须真的返回图片，才能断言卡片上的图被解码出来了
  if (url.pathname.startsWith('/poster/')) {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' })
    res.end(PNG_1X1)
    return
  }

  if (url.pathname.replace(/\/+$/, '').endsWith('/api.php/provide/vod')) {
    const ac = url.searchParams.get('ac')
    const ids = (url.searchParams.get('ids') || '').split(',').filter(Boolean)

    if (ac === 'list' || !ac) {
      counts.list++
      const page = url.searchParams.get('pg') || '1'
      send(listXml(Number(page), url.searchParams.get('t') || ''), 'text/xml; charset=utf-8')
      return
    }

    // 一次带多个 id = 列表页补封面；只带一个 = 打开影片详情
    if (ids.length > 1) {
      counts.pics++
      send(picsXml(ids), 'text/xml; charset=utf-8')
      return
    }

    counts.detail++
    send(detailXml(ids[0] || '1'), 'text/xml; charset=utf-8')
    return
  }

  if (url.pathname === '/epg.xml') {
    counts.epg++
    send(EPG_XML, 'application/xml; charset=utf-8')
    return
  }

  counts.other++
  res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' })
  res.end('not found')
})

await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve))

const stats = () => fetch(`${BASE}/__stats`).then((r) => r.json())

async function waitForCount(key, value, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  let last = await stats()
  while (Date.now() < deadline) {
    if (last[key] === value) return last
    await delay(300)
    last = await stats()
  }
  return last
}

/* ------------------------------------------------------------------ *
 * 2. 驱动真实应用
 * ------------------------------------------------------------------ */

const cleanEnv = { ...process.env, NODE_OPTIONS: '' }
delete cleanEnv.ELECTRON_RUN_AS_NODE
delete cleanEnv.ELECTRON_NO_ATTACH_CONSOLE

let electron
let cdp
let electronLog = ''

/**
 * 起一个一次性子进程并等它结束。
 *
 * 刻意用**异步** spawn：部分受限环境（沙箱 / 作业对象）会拒绝同步创建进程，
 * `spawnSync` 直接抛 EBUSY —— 那样 taskkill 根本不会执行，残留的 renderer 会持续空转拖垮整机。
 */
function runCommand(cmd, args) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, { stdio: 'ignore', windowsHide: true })
    } catch {
      resolve(false)
      return
    }
    child.on('error', () => resolve(false))
    child.on('close', () => resolve(true))
  })
}

/** Windows 上 child.kill() 只杀主进程，子进程会孤儿化空转，必须整棵树结束 */
async function killTree(child) {
  if (!child?.pid) return
  if (process.platform === 'win32') {
    await runCommand('taskkill', ['/F', '/T', '/PID', String(child.pid)])
    return
  }
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      /* ignore */
    }
  }
}

function launch() {
  electron = spawn(
    `${ROOT}/node_modules/electron/dist/electron.exe`,
    [
      '.',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${USER_DATA}`,
      '--in-process-gpu',
      '--disable-gpu'
    ],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: cleanEnv }
  )
  electron.stdout.on('data', (c) => (electronLog += c.toString()))
  electron.stderr.on('data', (c) => (electronLog += c.toString()))
}

async function waitForTarget(timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const list = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json())
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      /* 还没起来 */
    }
    await delay(400)
  }
  throw new Error('等待调试目标超时')
}

/** 事件钩子：截图要用 screencast 推上来的帧 */
let extraEventHandler = null

/**
 * 取一张**当前**画面的截图，返回 base64。
 *
 * 不用 `Page.captureScreenshot`：本机是无 GPU 的虚拟桌面，它经常交回一帧很旧的画面
 * （甚至不返回），那样截图会「证明」一件早就不是事实的事。
 */
function captureFrame(cdp, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      extraEventHandler = null
      reject(new Error('截图超时（screencast 没有推帧）'))
    }, timeoutMs)

    extraEventHandler = async (message) => {
      if (message.method !== 'Page.screencastFrame') return
      clearTimeout(timer)
      extraEventHandler = null
      try {
        await cdp.send('Page.screencastFrameAck', { sessionId: message.params.sessionId })
        await cdp.send('Page.stopScreencast')
      } catch {
        /* 收尾失败不影响拿到的帧 */
      }
      resolve(message.params.data)
    }

    cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 }).catch((error) => {
      clearTimeout(timer)
      extraEventHandler = null
      reject(error)
    })
  })
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl)
    let nextId = 1
    const pending = new Map()
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.method) {
        extraEventHandler?.(message)
        return
      }
      const entry = pending.get(message.id)
      if (!entry) return
      pending.delete(message.id)
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)))
      else entry.resolve(message.result)
    })
    socket.addEventListener('error', reject)
    socket.addEventListener('open', () =>
      resolve({
        send(method, params = {}) {
          const id = nextId++
          socket.send(JSON.stringify({ id, method, params }))
          return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej }))
        },
        close: () => socket.close()
      })
    )
  })
}

async function attach() {
  const target = await waitForTarget()
  cdp = await connect(target.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
}

async function evaluate(expression, timeoutMs = 60000) {
  const result = await Promise.race([
    cdp.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    }),
    delay(timeoutMs).then(() => {
      throw new Error('evaluate 超时')
    })
  ])
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  }
  return result.result.value
}

/** 等到页面上出现某个选择器 */
async function waitForSelector(selector, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = await evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`)
    if (found > 0) return found
    await delay(250)
  }
  return 0
}

/** 轮询直到表达式为真，返回最后一次的值（用于等待「封面补上」「分类切过去」这类异步结果） */
async function waitForExpression(expression, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  let value = await evaluate(expression)
  while (!value && Date.now() < deadline) {
    await delay(250)
    value = await evaluate(expression)
  }
  return value
}

async function goto(hash) {
  await evaluate(`location.hash = ${JSON.stringify(hash)}`)
  await delay(900)
}

const SEED = `(async () => {
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open('cineplayer')
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  const tx = db.transaction(['sources', 'settings'], 'readwrite')
  const done = new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(true)
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
  const now = Date.now()
  const sourceId = await new Promise((resolve, reject) => {
    const req = tx.objectStore('sources').add({
      name: '本地桩采集站',
      url: ${JSON.stringify(API_URL)},
      kind: 'maccms',
      isActive: false,
      classes: [],
      updatedAt: now,
      addedAt: now
    })
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  // 直播页只在选中「非采集源」时才渲染节目单区域，这里补一个空的 M3U 源
  await new Promise((resolve, reject) => {
    const req = tx.objectStore('sources').add({
      name: '本地桩直播源',
      url: '',
      kind: 'm3u',
      isActive: true,
      updatedAt: now,
      addedAt: now + 1
    })
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  const existing = await new Promise((resolve, reject) => {
    const req = tx.objectStore('settings').get(1)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  const merged = Object.assign(
    {
      id: 1, theme: 'dark', libraryView: 'poster', volume: 1, playbackRate: 1,
      rememberProgress: true, resumeThreshold: 5, autoplayNext: true,
      scanFolders: [], epgUrl: '', contentCacheMinutes: 60
    },
    existing || {},
    { epgUrl: ${JSON.stringify(EPG_URL)}, contentCacheMinutes: 60 }
  )
  await new Promise((resolve, reject) => {
    const req = tx.objectStore('settings').put(merged)
    req.onsuccess = () => resolve(true)
    req.onerror = () => reject(req.error)
  })
  await done
  return { sourceId, cacheMinutes: merged.contentCacheMinutes }
})()`

const CACHE_ROWS = `(async () => {
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open('cineplayer')
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  const rows = await new Promise((resolve, reject) => {
    const tx = db.transaction('apiCache', 'readonly')
    const req = tx.objectStore('apiCache').getAll()
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return rows.map((row) => ({ key: row.key, scope: row.scope, size: row.size }))
})()`
const COLLECTION_ROWS = `(async () => {
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open('cineplayer')
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  const rows = await new Promise((resolve, reject) => {
    const tx = db.transaction('collections', 'readonly')
    const req = tx.objectStore('collections').getAll()
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return rows.map((row) => ({
    key: row.key,
    vodId: row.vodId,
    note: row.note ?? null,
    episodeCount: row.episodeCount ?? null,
    newEpisodes: row.newEpisodes ?? null,
    syncedAt: row.syncedAt ?? null,
    syncError: row.syncError ?? null,
    watchedIndex: row.watchedIndex ?? null,
    watchedName: row.watchedName ?? null
  }))
})()`

const CLICK_REFRESH_LIST = `(async () => {
  const button = [...document.querySelectorAll('.collect__toolbar button')].find((item) =>
    (item.getAttribute('title') || '').includes('重新拉取列表')
  )
  if (!button) return false
  button.click()
  return true
})()`

const CLICK_REFRESH_EPG = `(async () => {
  const button = [...document.querySelectorAll('button')].find((item) =>
    item.textContent.includes('刷新节目单')
  )
  if (!button) return false
  button.click()
  return true
})()`

/** 片名 / 卡片数 / 封面：用来判断「分类点下去到底有没有生效」「封面有没有出来」 */
// 片名外面必须套一层括号：`??` 的优先级低于 `===`，不套会解析成 `x ?? ('' === 'y')`
const CARD_NAME = `(document.querySelector('.card__name')?.textContent?.trim() ?? '')`
const CARD_COUNT = `document.querySelectorAll('.card').length`
const POSTER_IMGS = `document.querySelectorAll('.card__poster img').length`
const FIRST_POSTER_DECODED = `(document.querySelector('.card__poster img')?.naturalWidth || 0) > 0`
const HERO_POSTER_DECODED = `(document.querySelector('.hero__poster img')?.naturalWidth || 0) > 0`
/** 父分类兜底时给用户的一次性说明 */
const NOTICE = `(document.querySelector('.collect__notice')?.textContent?.trim() ?? '')`
/** 当前高亮的分类名 */
const ACTIVE_CAT = `([...document.querySelectorAll('.cat')].find((b) => b.classList.contains('cat--active'))?.textContent?.trim() ?? '')`

/** 点左侧分类里名字完全匹配的那个按钮 */
const clickCategory = (name) => `(async () => {
  const button = [...document.querySelectorAll('.cat')].find(
    (item) => item.textContent.trim() === ${JSON.stringify(name)}
  )
  if (!button) return false
  button.click()
  return true
})()`

/* ------------------------------------------------------------------ *
 * 3. 用例
 * ------------------------------------------------------------------ */

let sourceId = 0

/** 历史遗留的测试用户数据目录（Windows 上常因文件占用删不掉） */
function staleUserDataDirs() {
  try {
    return readdirSync(`${ROOT}/.smoke`, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('userdata-cache-'))
      .map((entry) => entry.name)
      .filter((name) => name !== basename(USER_DATA))
  } catch {
    return []
  }
}

try {
  // 先回收上一次异常残留的测试进程，避免抢占 CDP 端口
  await runCommand(process.execPath, [`${ROOT}/scripts/clean-orphans.mjs`])
  mkdirSync(`${ROOT}/.smoke`, { recursive: true })

  console.log(`启动应用（隔离 userData：userdata-cache-${RUN_ID}）…`)
  launch()
  await attach()
  await delay(2500)

  /* ---------- 准备：写入采集源与节目单地址 ---------- */
  const seeded = await evaluate(SEED)
  sourceId = seeded.sourceId
  record('写入测试用采集源与节目单地址', typeof sourceId === 'number' && sourceId > 0, `sourceId=${sourceId}`)

  await evaluate('location.reload()')
  await delay(2500)
  await waitForSelector('.app-shell')

  /* ---------- 前置条件：采集缓存必须为空，否则后面的「首次请求」没有意义 ---------- */
  const warm = await evaluate(CACHE_ROWS)
  record(
    '前置条件：全新 userData 下没有任何采集缓存',
    warm.filter((row) => row.scope !== 'epg').length === 0,
    `已有条目=${warm.length}（${warm.map((row) => row.scope).join('、') || '无'}）`
  )

  /* ---------- A. 首次浏览：应当请求一次 ---------- */
  await goto('#/collect')
  const firstCards = await waitForSelector('.card', 25000)
  const afterFirst = await stats()
  record(
    '首次浏览分类会向采集站请求一次',
    firstCards === 20 && afterFirst.list === 1,
    `卡片=${firstCards} 列表请求=${afterFirst.list}`
  )

  /* ---------- A2. 列表接口不带封面：应当自动补齐并真的显示出来 ---------- */
  const posterImgs = await waitForExpression(`${POSTER_IMGS} === 20`)
  const firstDecoded = await waitForExpression(FIRST_POSTER_DECODED)
  const afterPosters = await stats()
  record(
    '列表不带封面时自动批量补齐并显示（真实解码）',
    posterImgs === true && firstDecoded === true && afterPosters.pics === 1,
    `封面元素=${await evaluate(POSTER_IMGS)} 首图已解码=${firstDecoded} 补封面请求=${afterPosters.pics}`
  )

  /* ---------- A3. 超长片名：换行显示，且不挤压相邻卡片 ---------- */
  /**
   * 回归用例：用户报的「影视名超过了挤在一起」。
   *
   * 根因是网格项的 `min-width: auto` —— 一个 `white-space: nowrap` 的长标题
   * 会把卡片撑得比自己的轨道还宽，标题于是直接压到隔壁卡片上。
   * 所以光断言「标题能换行」不够，必须同时断言「没有任何卡片横向溢出、没有标题盒重叠」。
   */
  const cardLayout = await evaluate(
    `(() => {
      const cards = Array.from(document.querySelectorAll('.grid .card'))
      if (cards.length < 2) return { ok: false, message: '卡片没渲染出来 count=' + cards.length }

      const boxes = cards.map((card) => {
        const el = card.querySelector('.card__name')
        const rect = el.getBoundingClientRect()
        return {
          text: el.textContent.trim(),
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
          lines: Math.round(el.clientHeight / parseFloat(getComputedStyle(el).lineHeight))
        }
      })

      const overflowing = cards
        .filter((card) => card.scrollWidth > card.clientWidth + 1)
        .map((card) => card.querySelector('.card__name').textContent.trim())

      const overlaps = []
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i]
          const b = boxes[j]
          if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) {
            overlaps.push(a.text + ' ↔ ' + b.text)
          }
        }
      }

      const long = boxes.find((box) => box.text.includes('物产展之女'))
      return {
        ok: true,
        count: cards.length,
        overflowing,
        overlaps,
        longLines: long ? long.lines : 0,
        longWidth: long ? Math.round(long.right - long.left) : 0,
        cardWidth: Math.round(cards[0].getBoundingClientRect().width)
      }
    })()`
  )
  record(
    '超长片名换行显示，不挤压相邻卡片',
    cardLayout.ok === true &&
      cardLayout.overflowing.length === 0 &&
      cardLayout.overlaps.length === 0 &&
      cardLayout.longLines >= 2 &&
      cardLayout.longWidth <= cardLayout.cardWidth + 1,
    cardLayout.ok
      ? `卡片=${cardLayout.count} 长名行数=${cardLayout.longLines} 长名宽=${cardLayout.longWidth}px ` +
        `卡片宽=${cardLayout.cardWidth}px 溢出=${JSON.stringify(cardLayout.overflowing)} 重叠=${JSON.stringify(cardLayout.overlaps)}`
      : cardLayout.message
  )

  // 留一张图：长片名换行后的列表长什么样（用户报的就是这里「挤在一起」）
  try {
    const shotDir = `${ROOT}/.smoke/shots`
    mkdirSync(shotDir, { recursive: true })
    const data = await captureFrame(cdp)
    if (data) {
      writeFileSync(`${shotDir}/collect-grid.png`, Buffer.from(data, 'base64'))
      console.log('  截图已保存：.smoke/shots/collect-grid.png（长片名换行、卡片互不挤压）')
    }
  } catch (error) {
    console.log(`  截图失败（不影响用例结论）：${error?.message ?? error}`)
  }

  /* ---------- B. 切页再回来：不应重复请求 ---------- */
  await goto('#/library')
  await goto('#/collect')
  const backCards = await waitForSelector('.card', 10000)
  const afterBack = await stats()
  record(
    '切到别的页面再回来不重复请求（命中缓存）',
    backCards === 20 && afterBack.list === 1,
    `卡片=${backCards} 列表请求=${afterBack.list}`
  )

  /* ---------- B2. 点击分类：内容必须真的换掉（回归：迟到响应被误丢弃） ---------- */
  await evaluate(clickCategory('喜剧片'))
  const switched = await waitForExpression(`${CARD_NAME} === '喜剧影片1'`)
  const afterSwitch = await stats()
  record(
    '点击分类会切换到该分类的内容',
    switched === true && afterSwitch.list === 2 && (await evaluate(CARD_COUNT)) === 20,
    `首卡=${await evaluate(CARD_NAME)} 卡片=${await evaluate(CARD_COUNT)} 列表请求=${afterSwitch.list}`
  )

  // 切回已经看过的「全部」：缓存命中，不应再打接口
  await evaluate(clickCategory('全部'))
  const switchedBack = await waitForExpression(`${CARD_NAME} === '全部影片1'`)
  const afterSwitchBack = await stats()
  record(
    '切回已看过的分类直接命中缓存',
    switchedBack === true && afterSwitchBack.list === 2,
    `首卡=${await evaluate(CARD_NAME)} 列表请求=${afterSwitchBack.list}`
  )

  /* ---------- B3. 父分类返回 0 条：应自动落到第一个子分类并说明 ---------- */
  const beforeParent = await stats()
  const parentClicked = await evaluate(clickCategory('电影片'))
  const fellBack = await waitForExpression(`${CARD_NAME} === '动作影片1'`)
  const noticeShown = await waitForExpression(`(${NOTICE}).indexOf('电影片') >= 0`)
  const afterParent = await stats()
  const activeAfterParent = await evaluate(ACTIVE_CAT)
  record(
    '父分类没有直属内容时自动落到第一个子分类',
    parentClicked === true &&
      fellBack === true &&
      noticeShown === true &&
      activeAfterParent === '动作片' &&
      (await evaluate(CARD_COUNT)) === 20 &&
      afterParent.list === beforeParent.list + 2,
    `首卡=${await evaluate(CARD_NAME)} 高亮=${activeAfterParent} 提示="${await evaluate(NOTICE)}" 列表请求=${beforeParent.list}→${afterParent.list}`
  )

  /* ---------- C. 详情首次打开请求一次 ---------- */
  await goto(`#/collect/detail?id=7&source=${sourceId}`)
  await waitForSelector('.hero__name', 25000)
  const afterDetail = await stats()
  record(
    '首次打开详情会请求一次',
    afterDetail.detail === 1,
    `详情请求=${afterDetail.detail}`
  )

  const heroDecoded = await waitForExpression(HERO_POSTER_DECODED)
  record(
    '详情页封面正常显示',
    heroDecoded === true,
    `hero 封面已解码=${heroDecoded}`
  )

  /* ---------- C2. 选集：详情页点一集 → 播放页能列出整条线路并换集 ---------- */
  /**
   * 「选集」面板要的不是「能播放」——而是**播放列表有没有被正确带进播放页**。
   * 所以这里刻意只断言列表与切换行为：桩站给的是 `cdn.example.com` 的假地址，
   * 播放本身必然失败，但选集的正确性与播放成功无关。
   */
  const episodeCount = await waitForSelector('.eps .ep', 20000)
  await evaluate(`[...document.querySelectorAll('.eps .ep')][1].click(), true`)
  await delay(1500)

  const queueBar = await evaluate(`(() => ({
    episodes: !!document.querySelector('.player__bar button[title="选集"]'),
    prev: !!document.querySelector('.player__bar button[title="上一集"]'),
    next: !!document.querySelector('.player__bar button[title="下一集"]'),
    hash: location.hash
  }))()`)
  record(
    '从详情页选集进播放页后出现「选集 / 上一集 / 下一集」',
    episodeCount === 2 &&
      queueBar.episodes === true &&
      queueBar.prev === true &&
      queueBar.next === true,
    `详情页集数=${episodeCount} 选集按钮=${queueBar.episodes} hash=${queueBar.hash}`
  )

  const panel = await evaluate(
    `(async () => {
      document.querySelector('.player__bar button[title="选集"]')?.click()
      // 不用 requestAnimationFrame：窗口被遮挡/不可见时它可能整帧不回调，
      // 于是 Vue 的 <transition> 会永远停在 enter-from 上，面板留在屏幕外
      await new Promise((r) => setTimeout(r, 400))
      const panelEl = document.querySelector('.player__panel')
      const style = panelEl ? getComputedStyle(panelEl) : null
      const rect = panelEl?.getBoundingClientRect()
      return {
        title: document.querySelector('.player__panel-title')?.textContent?.trim() ?? '',
        sub: document.querySelector('.player__panel-sub')?.textContent?.trim() ?? '',
        // 面板是不是真的「画出来了」：过渡若卡在 enter-from，元素会停在 translateX(100%) 上，
        // DOM 里查得到、断言也过，但用户什么都看不到
        geometry: panelEl
          ? {
              transform: style.transform,
              opacity: style.opacity,
              left: Math.round(rect.left),
              right: Math.round(rect.right),
              top: Math.round(rect.top),
              height: Math.round(rect.height),
              viewport: window.innerWidth
            }
          : null,
        items: [...document.querySelectorAll('.player__ep')].map((el) => ({
          name: el.textContent.trim(),
          active: el.classList.contains('player__ep--active')
        }))
      }
    })()`
  )
  console.log(`  [geometry] 选集面板=${JSON.stringify(panel.geometry)}`)
  // 留一张「选集面板」的图（仿腾讯视频电脑端的分集抽屉）
  try {
    const shotDir = `${ROOT}/.smoke/shots`
    mkdirSync(shotDir, { recursive: true })
    const data = await captureFrame(cdp)
    if (data) {
      writeFileSync(`${shotDir}/episodes-panel.png`, Buffer.from(data, 'base64'))
      console.log('  截图已保存：.smoke/shots/episodes-panel.png（播放页选集面板）')
    }
  } catch (error) {
    console.log(`  截图失败（不影响用例结论）：${error?.message ?? error}`)
  }

  record(
    '选集面板列出整条线路，并高亮当前正在播的那一集',
    panel.items.length === 2 &&
      panel.items[0].name === '第1集' &&
      panel.items[1].name === '第2集' &&
      panel.items[1].active === true &&
      panel.items[0].active === false &&
      panel.sub.includes('2'),
    `标题="${panel.title}" ${panel.sub} items=${JSON.stringify(panel.items)}`
  )

  /*
   * 光断言「DOM 里有面板」是不够的 —— 本轮就踩过：
   * 面板确实在 DOM 里、条目也读得到，但入场过渡卡在 `enter-from` 上，
   * 整块被推到 `translateX(100%)` 的屏幕外（实测 opacity 0.4）。
   * 所以这里再钉一次**可见性**：必须落在视口内、且不是半透明/透明。
   * （透明元素的 getBoundingClientRect 依然非零，只查存在性会被蒙过去。）
   */
  const g = panel.geometry
  record(
    '选集面板真的画在视口内（不是卡在入场位移里当隐身人）',
    !!g &&
      g.right <= g.viewport + 1 &&
      g.left < g.viewport &&
      g.height > 100 &&
      Number.parseFloat(g.opacity) > 0.9 &&
      (g.transform === 'none' || /matrix\(1, 0, 0, 1, 0, 0\)/.test(g.transform)),
    `geometry=${JSON.stringify(g)}`
  )

  const switchedEpisode = await evaluate(
    `(async () => {
      document.querySelectorAll('.player__ep')[0].click()
      await new Promise((r) => setTimeout(r, 1500))
      // 面板换集后保持打开（连播时不该每换一集都要重新点开），所以直接读高亮位置即可
      const items = [...document.querySelectorAll('.player__ep')].map((el) => ({
        name: el.textContent.trim(),
        active: el.classList.contains('player__ep--active')
      }))
      return { hash: decodeURIComponent(location.hash), items }
    })()`
  )
  record(
    '在选集面板里换集会真的切到那一集（路由与高亮同时跟上）',
    switchedEpisode.hash.includes('cdn.example.com/7/1.m3u8') &&
      switchedEpisode.items[0]?.active === true &&
      switchedEpisode.items[1]?.active === false,
    `hash=${switchedEpisode.hash} items=${JSON.stringify(switchedEpisode.items)}`
  )

  /* ---------- D. 返回列表再重开同一详情：不应重复请求 ---------- */
  await goto('#/collect')
  await delay(600)
  await goto(`#/collect/detail?id=7&source=${sourceId}`)
  await waitForSelector('.hero__name', 15000)
  const afterDetailAgain = await stats()
  const heroText = await evaluate(`document.querySelector('.hero__name')?.textContent?.trim() ?? ''`)
  record(
    '重开同一详情不重复请求（内存 + 落库缓存）',
    afterDetailAgain.detail === 1 && heroText === '测试影片7',
    `详情请求=${afterDetailAgain.detail} 标题=${heroText}`
  )

  /* ---------- D2. 追剧：加入 / 观看进度 / 同步更新 ---------- */
  /**
   * 「同步追剧」要验证三件事，缺一不可：
   *   1. 收藏时记下集数基线 —— 没有基线，「有没有新集」就无从比较；
   *   2. 同步真的回源了一次详情（不是只改了界面）；
   *   3. 看过的集数会被记进条目，回来能「继续看」。
   * 桩站通过 `/__note` 覆写备注来模拟「站点后来更新了」。
   */
  const starClicked = await evaluate(
    `(async () => {
      const button = [...document.querySelectorAll('.hero__actions button')].find((item) =>
        item.textContent.includes('追剧')
      )
      if (!button) return { ok: false, reason: '详情页没有「加入追剧」按钮' }
      button.click()
      await new Promise((r) => setTimeout(r, 900))
      return { ok: true, label: button.textContent.trim() }
    })()`
  )
  const afterStar = await evaluate(COLLECTION_ROWS)
  record(
    '加入追剧后条目落库，并记下当刻的集数基线',
    starClicked.ok === true &&
      afterStar.length === 1 &&
      afterStar[0].vodId === '7' &&
      afterStar[0].note === NOTE_BASE &&
      afterStar[0].episodeCount === 12,
    starClicked.ok ? `按钮="${starClicked.label}" 条目=${JSON.stringify(afterStar)}` : starClicked.reason
  )

  // 播第 2 集：观看进度应当回写到追剧条目
  await waitForSelector('.eps .ep', 15000)
  await evaluate(`[...document.querySelectorAll('.eps .ep')][1].click(), true`)
  await delay(1800)
  const afterWatch = await evaluate(COLLECTION_ROWS)
  record(
    '播放过的那一集被记进追剧条目（观看进度回写）',
    afterWatch.length === 1 && afterWatch[0].watchedIndex === 1 && afterWatch[0].watchedName === '第2集',
    `watchedIndex=${afterWatch[0]?.watchedIndex} watchedName=${afterWatch[0]?.watchedName}`
  )

  await goto('#/collect')
  await waitForSelector('.card', 15000)
  await evaluate(
    `[...document.querySelectorAll('.segmented button')].find((item) => item.textContent.includes('追剧'))?.click(), true`
  )
  await delay(700)
  const starCard = await evaluate(
    `(() => ({
      names: [...document.querySelectorAll('.card__name')].map((el) => el.textContent.trim()),
      resume: document.querySelector('.card__resume')?.textContent?.trim() ?? '',
      note: document.querySelector('.card__note')?.textContent?.trim() ?? '',
      newBadge: !!document.querySelector('.card__new'),
      syncButton: [...document.querySelectorAll('.collect__toolbar button')].some((item) =>
        item.textContent.includes('同步追剧')
      ),
      hint: (document.querySelector('.collect__toolbar .view-subtitle')?.textContent ?? '')
        .replace(/\\s+/g, ' ')
        .trim()
    }))()`
  )
  record(
    '追剧列表显示「继续看 第2集」，并有同步入口',
    starCard.names.includes('测试影片7') &&
      starCard.resume.includes('第2集') &&
      starCard.syncButton === true &&
      starCard.newBadge === false,
    `卡片=${JSON.stringify(starCard.names)} 继续观看="${starCard.resume}" 同步按钮=${starCard.syncButton}` +
      ` 有新集角标=${starCard.newBadge} 提示="${starCard.hint}"`
  )

  // 站点更新了集数 → 同步应当回源一次，并把备注刷新掉
  const beforeSync = (await stats()).detail
  await fetch(`${BASE}/__note?id=7&value=${encodeURIComponent(NOTE_UPDATED)}`)
  const syncClicked = await evaluate(
    `(() => {
      const button = [...document.querySelectorAll('.collect__toolbar button')].find((item) =>
        item.textContent.includes('同步追剧')
      )
      if (!button) return false
      button.click()
      return true
    })()`
  )
  const afterSyncCount = await waitForCount('detail', beforeSync + 1, 25000)
  await delay(1000)
  const synced = await evaluate(
    `(() => ({
      note: document.querySelector('.card__note')?.textContent?.trim() ?? '',
      newBadge: !!document.querySelector('.card__new'),
      meta: (document.querySelector('.card__meta')?.textContent ?? '').replace(/\\s+/g, ' ').trim(),
      hint: (document.querySelector('.collect__toolbar .view-subtitle')?.textContent ?? '')
        .replace(/\\s+/g, ' ')
        .trim()
    }))()`
  )
  record(
    '点「同步追剧」真的回源一次，并刷新了备注',
    syncClicked === true && afterSyncCount.detail === beforeSync + 1 && synced.note === NOTE_UPDATED,
    `详情请求=${beforeSync} → ${afterSyncCount.detail} 卡片备注="${synced.note}"`
  )
  record(
    '集数变多时标出「有新集」',
    synced.newBadge === true && synced.hint.includes('有新集'),
    `角标=${synced.newBadge} 提示="${synced.hint}" 第二行="${synced.meta}"`
  )

  const syncedRows = await evaluate(COLLECTION_ROWS)
  record(
    '同步结果落库（集数基线跟着更新，下次才有得比）',
    syncedRows.length === 1 && syncedRows[0].episodeCount === 14 && syncedRows[0].newEpisodes === true,
    `episodeCount=${syncedRows[0]?.episodeCount} newEpisodes=${syncedRows[0]?.newEpisodes} syncError=${syncedRows[0]?.syncError}`
  )

  // 「继续观看」：带着看到第几集的下标进详情页，应当直接起播那一集
  const resumed = await evaluate(
    `(async () => {
      const button = document.querySelector('.card__resume')
      if (!button) return { ok: false, reason: '追剧卡片上没有「继续观看」' }
      button.click()
      const deadline = Date.now() + 25000
      while (Date.now() < deadline && !decodeURIComponent(location.hash).includes('cdn.example.com/7/2.m3u8')) {
        await new Promise((r) => setTimeout(r, 200))
      }
      return { ok: true, hash: decodeURIComponent(location.hash) }
    })()`
  )
  record(
    '「继续看 第2集」直接起播那一集（不用再点一次）',
    resumed.ok === true && resumed.hash.includes('cdn.example.com/7/2.m3u8'),
    resumed.ok ? `hash=${resumed.hash}` : resumed.reason
  )

  /* ---------- E. 直播页节目单 ---------- */
  await goto('#/iptv')
  await delay(2500)
  const afterEpg = await stats()
  const epgNoteFirst = await evaluate(
    `[...document.querySelectorAll('.iptv__epg-note')].map((n) => n.textContent.replace(/\\s+/g, ' ').trim()).join(' | ')`
  )
  await goto('#/library')
  await goto('#/iptv')
  await delay(1500)
  const afterEpgBack = await stats()
  record(
    '节目单只下载一次，进入直播页不会重复拉取',
    afterEpg.epg === 1 && afterEpgBack.epg === 1 && epgNoteFirst.includes('节目单已加载'),
    `节目单请求=${afterEpg.epg} → 再次进入后=${afterEpgBack.epg} · 提示=${epgNoteFirst}`
  )

  /* ---------- F. 缓存确实落到了本地 ---------- */
  const rows = await evaluate(CACHE_ROWS)
  const scopes = new Set(rows.map((row) => row.scope))
  record(
    '缓存条目已写入本地库（列表 / 详情 / 节目单）',
    rows.length >= 3 && scopes.has('collect-list') && scopes.has('collect-detail') && scopes.has('epg'),
    `${rows.length} 条：${[...scopes].join('、')}`
  )

  /* ---------- G. 重启应用后仍然是原次数 ---------- */
  console.log('重启应用…')
  const beforeRestart = await stats()
  try {
    cdp?.close()
  } catch {
    /* ignore */
  }
  await killTree(electron)
  await delay(2500)
  launch()
  await attach()
  await delay(3000)
  await waitForSelector('.app-shell')

  await goto('#/collect')
  const restartCards = await waitForSelector('.card', 25000)
  const restartPosters = await waitForExpression(`${POSTER_IMGS} === 20`)
  const afterRestart = await stats()
  record(
    '重启应用后列表直接命中缓存（关键）',
    restartCards === 20 && afterRestart.list === beforeRestart.list,
    `卡片=${restartCards} 列表请求=${beforeRestart.list} → ${afterRestart.list}`
  )
  record(
    '重启应用后封面仍来自缓存（不再补一次）',
    restartPosters === true && afterRestart.pics === beforeRestart.pics,
    `封面元素=${await evaluate(POSTER_IMGS)} 补封面请求=${beforeRestart.pics} → ${afterRestart.pics}`
  )

  await goto(`#/collect/detail?id=7&source=${sourceId}`)
  await waitForSelector('.hero__name', 15000)
  const afterRestartDetail = await stats()
  record(
    '重启应用后详情直接命中缓存',
    afterRestartDetail.detail === beforeRestart.detail,
    `详情请求=${afterRestartDetail.detail}`
  )

  await goto('#/iptv')
  await delay(2500)
  const afterRestartEpg = await stats()
  const epgNote = await evaluate(
    `[...document.querySelectorAll('.iptv__epg-note')].map((n) => n.textContent.replace(/\\s+/g, ' ').trim()).join(' | ')`
  )
  record(
    '重启应用后节目单直接命中缓存（含界面提示）',
    afterRestartEpg.epg === beforeRestart.epg && epgNote.includes('缓存于'),
    `节目单请求=${afterRestartEpg.epg} · 提示=${epgNote}`
  )

  /* ---------- H. 只有手动刷新才回源 ---------- */
  await goto('#/collect')
  await waitForSelector('.card', 10000)
  const beforeRefresh = (await stats()).list
  const clicked = await evaluate(CLICK_REFRESH_LIST)
  const afterRefresh = await waitForCount('list', beforeRefresh + 1)
  record(
    '点「刷新列表」后确实回源一次',
    clicked === true && afterRefresh.list === beforeRefresh + 1,
    `列表请求=${beforeRefresh} → ${afterRefresh.list}`
  )

  await goto('#/iptv')
  await delay(1500)
  const beforeEpgRefresh = (await stats()).epg
  const epgClicked = await evaluate(CLICK_REFRESH_EPG)
  const afterEpgRefresh = await waitForCount('epg', beforeEpgRefresh + 1)
  record(
    '点「刷新节目单」后确实重新下载一次',
    epgClicked === true && afterEpgRefresh.epg === beforeEpgRefresh + 1,
    `按钮命中=${epgClicked} 节目单请求=${beforeEpgRefresh} → ${afterEpgRefresh.epg}`
  )

  /* ---------- I. 设置页能看到缓存状态 ---------- */
  await goto('#/settings')
  await waitForSelector('.panel', 10000)
  await delay(600)
  const cachePanel = await evaluate(
    `(() => {
      const hints = [...document.querySelectorAll('.row__hint')].map((node) => node.textContent.trim())
      const detail = hints.find((text) => text.includes('列表') && text.includes('详情')) || ''
      return { hasPanel: (document.body.innerText || '').includes('内容缓存'), text: detail }
    })()`
  )
  record(
    '设置页展示内容缓存条目与占用',
    cachePanel.hasPanel && /\d/.test(cachePanel.text),
    cachePanel.text || '未渲染'
  )

  /* ---------- J. 关闭缓存后应当每次都回源 ---------- */
  await evaluate(
    `window.api && (async () => {
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open('cineplayer')
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
      const tx = db.transaction('settings', 'readwrite')
      const row = await new Promise((resolve, reject) => {
        const req = tx.objectStore('settings').get(1)
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
      await new Promise((resolve, reject) => {
        const req = tx.objectStore('settings').put(Object.assign({}, row, { contentCacheMinutes: 0 }))
        req.onsuccess = () => resolve(true)
        req.onerror = () => reject(req.error)
      })
      return true
    })()`
  )
  await evaluate('location.reload()')
  await delay(2500)
  const beforeOff = (await stats()).list
  await goto('#/collect')
  await waitForSelector('.card', 25000)
  await goto('#/library')
  await goto('#/collect')
  await waitForSelector('.card', 12000)
  const afterOff = (await stats()).list
  record(
    '把有效期设为「关闭」后每次都回源',
    afterOff === beforeOff + 2,
    `关闭前=${beforeOff} 关闭后=${afterOff}`
  )
} catch (error) {
  record('测试执行', false, String(error?.message ?? error))
} finally {
  try {
    cdp?.close()
  } catch {
    /* ignore */
  }
  await killTree(electron)
  await new Promise((res) => server.close(res))
  await delay(1000)

  const failed = results.filter((r) => !r.ok)
  console.log(`\n===== ${results.length - failed.length}/${results.length} 通过 =====`)
  if (failed.length && electronLog) {
    console.log('--- electron 日志尾部 ---')
    console.log(electronLog.split('\n').slice(-25).join('\n'))
  }

  if (failed.length) {
    console.log(`保留本次用户数据目录以便排查：${USER_DATA}`)
  } else {
    // 成功后清掉本次目录，并顺手回收历史遗留的测试目录（失败说明被占用，忽略即可）
    for (const name of [basename(USER_DATA), ...staleUserDataDirs()]) {
      try {
        rmSync(`${ROOT}/.smoke/${name}`, { recursive: true, force: true })
      } catch {
        /* 被占用时留着，.smoke 已在 .gitignore 内 */
      }
    }
  }

  process.exit(failed.length ? 1 : 0)
}
