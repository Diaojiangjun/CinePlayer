/**
 * 真实站点端到端探针（**手动运行，不在 `npm run smoke` 里**）。
 *
 * 用途：桩站只能验证「我们以为的站点行为」。真实采集站会有些桩站没想到的毛病 ——
 * 比如 `ac=list` 不返回 `vod_pic`、父分类按 id 过滤返回 0 条。
 * 改动采集相关逻辑后，除了冒烟，值得再跑一次这个：
 *
 *   node scripts/probe-real-source.mjs
 *
 * 验证三件事：
 *   1) 列表能渲染，且封面对真实图床真的解码成功（`naturalWidth > 0`）；
 *   2) 点叶子分类，内容真的换掉；
 *   3) 点父分类（站点返回 0 条）能自动落到第一个子分类并给出提示。
 *
 * 注意：需要联网，且依赖第三方站点，因此不适合放进 CI。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\\/g, '/').replace(/\/$/, '')
const CDP_PORT = 9227
const USER_DATA = `${ROOT}/.smoke/_tmp-real-probe`
/**
 * 目标采集接口。
 *
 * 具体站点地址刻意不写进仓库 —— 免得把某个真实站点固化成默认值，
 * 运行时用命令行参数或环境变量传进来：
 *
 *   node scripts/probe-real-source.mjs https://<采集接口>/api.php/provide/vod/
 *   CINEPLAYER_PROBE_API=https://<采集接口>/api.php/provide/vod/ node scripts/probe-real-source.mjs
 */
const API_URL =
  process.argv.slice(2).find((arg) => /^https?:\/\//i.test(arg)) ||
  process.env.CINEPLAYER_PROBE_API ||
  ''

if (!API_URL) {
  console.error(
    '[probe-real-source] 缺少采集接口地址。\n' +
      '用法：node scripts/probe-real-source.mjs <采集接口地址>\n' +
      '  或：CINEPLAYER_PROBE_API=<采集接口地址> node scripts/probe-real-source.mjs'
  )
  process.exit(1)
}

mkdirSync(USER_DATA, { recursive: true })

const cleanEnv = { ...process.env, NODE_OPTIONS: '' }
delete cleanEnv.ELECTRON_RUN_AS_NODE
delete cleanEnv.ELECTRON_NO_ATTACH_CONSOLE

const electron = spawn(
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
let log = ''
electron.stdout.on('data', (c) => (log += c.toString()))
electron.stderr.on('data', (c) => (log += c.toString()))

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

function connect(wsUrl) {
  return new Promise((res, rej) => {
    const socket = new WebSocket(wsUrl)
    let nextId = 1
    const pending = new Map()
    socket.addEventListener('message', (event) => {
      const m = JSON.parse(event.data)
      const entry = pending.get(m.id)
      if (!entry) return
      pending.delete(m.id)
      if (m.error) entry.reject(new Error(JSON.stringify(m.error)))
      else entry.resolve(m.result)
    })
    socket.addEventListener('error', rej)
    socket.addEventListener('open', () =>
      res({
        send(method, params = {}) {
          const id = nextId++
          socket.send(JSON.stringify({ id, method, params }))
          return new Promise((a, b) => pending.set(id, { resolve: a, reject: b }))
        },
        close: () => socket.close()
      })
    )
  })
}

const target = await waitForTarget()
const cdp = await connect(target.webSocketDebuggerUrl)
await cdp.send('Runtime.enable')
await cdp.send('Page.enable')

async function evaluate(expression, timeoutMs = 90000) {
  const result = await Promise.race([
    cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }),
    delay(timeoutMs).then(() => {
      throw new Error('evaluate 超时')
    })
  ])
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
  return result.result.value
}

/** 轮询直到表达式为真；超时返回最后一次的值（不抛错，便于打印诊断） */
async function waitFor(expression, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs
  let value = await evaluate(expression)
  while (!value && Date.now() < deadline) {
    await delay(300)
    value = await evaluate(expression)
  }
  return value
}

async function shot(name) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
  const file = `${ROOT}/.smoke/_probe/${name}.png`
  mkdirSync(`${ROOT}/.smoke/_probe`, { recursive: true })
  writeFileSync(file, Buffer.from(data, 'base64'))
  console.log(`    截图 → ${file}`)
}

await delay(2500)

const seeded = await evaluate(`(async () => {
  const db = await new Promise((res, rej) => {
    const req = indexedDB.open('cineplayer')
    req.onsuccess = () => res(req.result)
    req.onerror = () => rej(req.error)
  })
  // 可重复运行：先清掉上一轮留下的源，保证只有一个 active。
  // 必须单独开一个事务——两个事务之间 await 会让前一个自动提交。
  await new Promise((res) => {
    const clearTx = db.transaction('sources', 'readwrite')
    const req = clearTx.objectStore('sources').clear()
    req.onsuccess = () => res()
    req.onerror = () => res()
  })
  const tx = db.transaction('sources', 'readwrite')
  const id = await new Promise((res, rej) => {
    const req = tx.objectStore('sources').add({
      name: '线上采集（探针）', url: ${JSON.stringify(API_URL)}, kind: 'maccms',
      isActive: true, classes: [], updatedAt: Date.now(), addedAt: Date.now()
    })
    req.onsuccess = () => res(req.result)
    req.onerror = () => rej(req.error)
  })
  return id
})()`)
console.log('已写入线上采集源 sourceId =', seeded)

// 默认路由是 /library，必须显式进入采集页
await evaluate(`location.hash = '#/collect'`)
await delay(1500)
await evaluate('location.reload()')
await delay(2500)

const arrived = await waitFor(`document.querySelector('.collect') !== null`, 20000)
const rendered = await waitFor(`document.querySelectorAll('.card').length > 0`, 45000)
const cards = await evaluate(`document.querySelectorAll('.card').length`)
console.log(`\n[0] 进入采集页=${arrived} 列表渲染=${rendered}`)
console.log(`[1] 列表渲染：卡片 ${cards} 张`)

if (cards === 0) {
  const dump = await evaluate(`(() => ({
    route: location.hash,
    text: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 500)
  }))()`)
  console.log('    ⚠️ 没有卡片，页面诊断：', JSON.stringify(dump, null, 2))
  await shot('probe-empty')
}

// 封面：所有卡片都该有 img，且至少 3 张真的解码出来
await waitFor(`document.querySelectorAll('.card__poster img').length === ${cards}`, 30000)
await waitFor(
  `[...document.querySelectorAll('.card__poster img')].filter((i) => i.naturalWidth > 0).length >= 3`,
  30000
)
const stats = await evaluate(`(() => {
  const imgs = [...document.querySelectorAll('.card__poster img')]
  return {
    withImg: imgs.length,
    decoded: imgs.filter((i) => i.naturalWidth > 0).length,
    sample: imgs.slice(0, 3).map((i) => i.src),
    firstCard: document.querySelector('.card__name')?.textContent?.trim() ?? '',
    total: (document.body.innerText.match(/共\\s*(\\d+)\\s*条/) || [])[1] || ''
  }
})()`)
console.log(`[2] 封面：带 img 的卡片 ${stats.withImg}/${cards}，已解码 ${stats.decoded} 张`)
console.log(`    示例：${stats.sample.join('\n          ')}`)
console.log(`    首卡=${stats.firstCard} 总数=${stats.total}`)
await shot('probe-list')

const cats = await evaluate(
  `[...document.querySelectorAll('.cat')].map((b) => b.textContent.trim())`
)
console.log(`\n[3] 分类按钮（${cats.length} 个）：${cats.slice(0, 12).join(' / ')}`)

/** 点一个分类，等列表稳定后再读结果 */
async function pickCat(name) {
  const before = await evaluate(`document.querySelector('.card__name')?.textContent?.trim() ?? ''`)
  const clicked = await evaluate(`(async () => {
    const b = [...document.querySelectorAll('.cat')].find((x) => x.textContent.trim() === ${JSON.stringify(name)})
    if (!b) return false
    b.click()
    return true
  })()`)
  if (!clicked) return { name, clicked: false }
  // 先等「离开旧内容」，再等「新内容出现或进入明确的空态」
  await waitFor(
    `document.querySelector('.card__name')?.textContent?.trim() !== ${JSON.stringify(before)} ||
     document.querySelector('.collect__empty') !== null`,
    40000
  )
  // 等异步的封面补全 / 父分类兜底落定
  await waitFor(
    `document.querySelectorAll('.card').length > 0 ||
     document.querySelector('.collect__notice') !== null`,
    20000
  )
  await delay(1200)
  const state = await evaluate(`(() => ({
    first: document.querySelector('.card__name')?.textContent?.trim() ?? '',
    cards: document.querySelectorAll('.card').length,
    total: (document.body.innerText.match(/共\\s*(\\d+)\\s*条/) || [])[1] || '',
    active: [...document.querySelectorAll('.cat')].find((b) => b.classList.contains('cat--active'))?.textContent.trim() ?? '',
    empty: document.querySelector('.collect__empty')?.textContent?.trim() ?? '',
    notice: document.querySelector('.collect__notice')?.textContent?.trim() ?? '',
    err: document.querySelector('.collect__error')?.textContent?.trim() ?? '',
    decoded: [...document.querySelectorAll('.card__poster img')].filter((i) => i.naturalWidth > 0).length
  }))()`)
  return { name, clicked, before, ...state }
}

// 叶子分类（动作片，type_pid=1 的子节点）应当有内容
const leaf = await pickCat('动作片')
console.log(`\n[4] 点击叶子分类「动作片」：`)
console.log(`    切换前首卡=${leaf.before}`)
console.log(`    切换后：卡片=${leaf.cards} 张 首卡=${leaf.first} 总数=${leaf.total} 高亮=${leaf.active}`)
console.log(`    封面已解码=${leaf.decoded} 张 空态="${leaf.empty}" 错误="${leaf.err}"`)
await shot('probe-leaf')
console.log(`    ${leaf.cards > 0 && leaf.first !== leaf.before ? '✅ 叶子分类切换生效' : '❌ 叶子分类切换未生效'}`)

// 父分类（电影片，type_pid=0，站点按父 id 过滤返回 0 条）—— 看看表现
const parent = await pickCat('电影片')
console.log(`\n[5] 点击父分类「电影片」：`)
console.log(`    切换前首卡=${parent.before}`)
console.log(`    切换后：卡片=${parent.cards} 张 总数=${parent.total} 高亮=${parent.active}`)
console.log(`    空态提示="${parent.empty}" 错误="${parent.err}"`)
console.log(`    兜底提示="${parent.notice}"`)
console.log(`    ${parent.cards > 0 && parent.active === '动作片' && parent.notice.includes('电影片') ? '✅ 父分类自动落到子分类生效' : '❌ 父分类兜底未生效'}`)
await shot('probe-parent')

try {
  cdp.close()
} catch {
  /* ignore */
}
electron.kill()
await delay(600)
console.log('\n--- electron 日志尾部 ---')
console.log(log.split('\n').slice(-10).join('\n'))
process.exit(0)
