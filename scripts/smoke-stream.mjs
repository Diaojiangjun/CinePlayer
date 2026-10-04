/**
 * IPTV / HLS 端到端冒烟测试
 *
 * 验证三件事：
 *  1. live:playlist / epg:fetch 两个 IPC 能真实拉取远程资源（走 Electron net）
 *  2. 主进程补齐跨域头后，渲染层能直接 fetch 无 CORS 头的分片（IPTV 常态）
 *  3. 播放页用 hls.js 真的把 m3u8 播起来
 *
 * 关键设计：本地 HTTP 服务器**故意不返回 Access-Control-Allow-Origin**，
 * 用来复现真实 IPTV 分片服务器的行为，从而证明跨域注入确实生效。
 *
 * 运行：node scripts/smoke-stream.mjs
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, readSync, closeSync, statSync } from 'node:fs'
import { resolve, extname, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\\/g, '/').replace(/\/$/, '')

/**
 * 起一个一次性子进程并等它结束。
 *
 * 刻意用**异步** spawn：部分受限环境（沙箱 / 作业对象）会拒绝同步创建进程，
 * `spawnSync` 直接抛 EBUSY —— 那样 taskkill 根本不会执行，残留的 renderer 会持续空转。
 */
function runCommand(cmd, args, options = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, { windowsHide: true, ...options })
    } catch {
      resolve(null)
      return
    }
    child.on('error', () => resolve(null))
    child.on('close', (code) => resolve(code))
  })
}

/**
 * Windows 上 child.kill() 只杀主进程，renderer / GPU 子进程会变成孤儿并持续空转。
 * 必须连同进程树一起结束，否则反复跑冒烟会拖垮整机。
 */
async function killTree(child) {
  if (!child?.pid) return
  if (process.platform === 'win32') {
    await runCommand('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' })
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

/** 通过 CDP 的 Browser.close 让 Electron 自己退出，比强杀更干净 */
async function closeBrowser() {
  try {
    const version = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`).then((r) => r.json())
    const socket = new WebSocket(version.webSocketDebuggerUrl)
    await new Promise((resolve) => socket.addEventListener('open', resolve))
    socket.send(JSON.stringify({ id: 1, method: 'Browser.close' }))
    await delay(1500)
    socket.close()
  } catch {
    /* 拿不到就交给 killTree */
  }
}
const PORT = 8788
const CDP_PORT = 9223
/** 每轮唯一的运行号：拿它拼出本轮专属的播放地址，上一轮残留的片头配置就撞不上 */
const RUN_ID = Date.now().toString(36)
const DIR = `${ROOT}/.smoke/hls`
const USER_DATA = `${ROOT}/.smoke/userdata-stream`
const FFMPEG = `${ROOT}/node_modules/@ffmpeg-installer/win32-x64/ffmpeg.exe`

const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

/* ------------------------------------------------------------------ *
 * 1. 准备素材
 * ------------------------------------------------------------------ */

mkdirSync(DIR, { recursive: true })

/**
 * HLS 测试流：2 秒一片的短线直播流。
 *
 * ⚠️ 同样刻意**不带音轨**（`-an`）—— 原因见下方 throttled.mp4 的注释：
 * 本环境的音频渲染器起不来，带音轨的媒体元素一律以
 * `MEDIA_ERR_DECODE(3) / AUDIO_RENDERER_ERROR` 结束。
 * 这个用例要验的是「我方 HLS 接入（播放列表解析 → 分片拉取 → MSE 追加 → 出画面）」，
 * 把音频这条环境死路留在里面，只会让一个真用例永远假红。
 */
if (!existsSync(`${DIR}/index.m3u8`)) {
  console.log('生成 HLS 测试流…')
  const ff = await runCommand(
    FFMPEG,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=640x360:rate=25:duration=12',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-g',
      '50',
      // ⚠️ 与 throttled.mp4 同因：本环境音频渲染器起不来，分片一旦带音轨，
      // MSE 追加后媒体元素就会以 AUDIO_RENDERER_ERROR 收场，播放根本不会开始。
      // 这里测的是「hls.js 能不能把 m3u8 拉起来播」，不该被环境限制污染 → 纯视频。
      '-an',
      '-f',
      'hls',
      '-hls_time',
      '2',
      '-hls_list_size',
      '0',
      '-hls_segment_filename',
      `${DIR}/seg%d.ts`,
      `${DIR}/index.m3u8`
    ],
    { stdio: 'inherit' }
  )
  if (ff !== 0) {
    console.error('生成 HLS 素材失败')
    process.exit(1)
  }
}

/**
 * 限速用的渐进式 MP4。
 *
 * 为什么要它：进度条「点了有没有立刻反应」和「加载中有没有反馈」都只在**数据来不及到**时才看得出来。
 * 本地磁盘或 localhost 全速跑的话，跳转瞬间就完成了，什么都测不到。
 * 服务器再按固定速率吐数据。
 *
 * ⚠️ 两个刻意的选择：
 *  1. `+faststart` 把 moov 放文件头 —— 否则浏览器要先跑文件尾取 moov，拿不到时长也不支持 Range 跳转；
 *  2. **不带音轨（`-an`）** —— 本环境（`--disable-gpu --in-process-gpu` 的虚拟化桌面）
 *     音频渲染器起不来，带音轨的媒体元素会直接以
 *     `MEDIA_ERR_DECODE(3) / AUDIO_RENDERER_ERROR` 结束，播放根本不会发生。
 *     测的是进度条与缓冲反馈，不该被这个环境限制污染。
 */
const SLOW_FILE = `${DIR}/throttled.mp4`
const SLOW_DURATION = 30

if (!existsSync(SLOW_FILE)) {
  console.log('生成限速测试素材…')
  const ff = await runCommand(
    FFMPEG,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `testsrc=size=640x360:rate=25:duration=${SLOW_DURATION}`,
      // 编码参数与 make-fixtures 保持一致：`ultrafast` 不产生 B 帧。
      // 换成 veryfast/crf 这类带 B 帧的档位后，本环境的解码路径会直接报
      // MEDIA_ERR_DECODE(3) —— 素材自己要「能播」，才谈得上测播放行为。
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-g',
      '50',
      '-an',
      '-movflags',
      '+faststart',
      SLOW_FILE
    ],
    { stdio: 'inherit' }
  )
  if (ff !== 0) {
    console.error('生成限速测试素材失败')
    process.exit(1)
  }
}

/**
 * 该素材的「实时码率」——即播放 1 秒内容需要的字节数。
 * 限速值按它的倍数来定，这样换素材、换参数都不用重新调常数。
 */
const CONTENT_BYTES_PER_SEC = statSync(SLOW_FILE).size / SLOW_DURATION

/** 供 live:playlist 解析的 M3U 订阅（含分组与 tvg 属性） */
const SUBSCRIPTION = `#EXTM3U
#EXTINF:-1 tvg-id="cctv1" tvg-name="CCTV-1" tvg-logo="" group-title="央视",CCTV-1 综合
http://127.0.0.1:${PORT}/index.m3u8
#EXTINF:-1 tvg-id="cctv2" group-title="央视",CCTV-2 财经
http://127.0.0.1:${PORT}/index.m3u8
#EXTINF:-1 tvg-id="hunan" group-title="卫视",湖南卫视
http://127.0.0.1:${PORT}/index.m3u8
#EXTINF:-1,无属性频道
http://127.0.0.1:${PORT}/index.m3u8
`
writeFileSync(`${DIR}/list.m3u`, SUBSCRIPTION, 'utf8')

/** 供 epg:fetch 解析的 XMLTV 节目单 */
const pad = (n) => String(n).padStart(2, '0')
const stamp = (offsetMinutes) => {
  const d = new Date(Date.now() + offsetMinutes * 60 * 1000)
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00 +0000`
}
writeFileSync(
  `${DIR}/epg.xml`,
  `<?xml version="1.0" encoding="UTF-8"?>
<tv generator-info-name="smoke">
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
</tv>`,
  'utf8'
)

/* ------------------------------------------------------------------ *
 * 2. 起一个「不带 CORS 头」的静态服务器
 * ------------------------------------------------------------------ */

const MIME = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.m3u': 'audio/x-mpegurl',
  '.xml': 'application/xml'
}

const SERVE_ROOT = resolve(DIR)

/**
 * 按指定速率吐一个支持 Range 的文件；`rate` 传 Infinity 表示不限速。
 *
 * 限速做法是「每写一块等一会」，不是 sleep 完一次性发 ——
 * 只有这样浏览器的缓冲才会真的慢慢长，`video.buffered` 才是渐进的。
 * Range 必须支持：点进度条跳转靠的就是它，不支持的话浏览器只能从头下。
 */
function serveFile(req, res, file, rate, contentType = 'video/mp4') {
  const total = statSync(file).size
  const range = req.headers.range
  let start = 0
  let end = total - 1
  if (range) {
    const matched = /bytes=(\d*)-(\d*)/.exec(range)
    if (matched) {
      if (matched[1]) {
        start = Number(matched[1])
        end = matched[2] ? Number(matched[2]) : total - 1
      } else if (matched[2]) {
        // 后缀区间 `bytes=-N` 表示「最后 N 个字节」，不是「第 0 到第 N 字节」。
        // 弄反了浏览器会拿到错位的数据，直接 MEDIA_ERR_DECODE。
        start = Math.max(0, total - Number(matched[2]))
        end = total - 1
      }
    }
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
    res.writeHead(416, { 'Content-Range': `bytes */${total}` }).end()
    return
  }
  end = Math.min(end, total - 1)

  const headers = {
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    // 别让 Chromium 自带的 HTTP 缓存替我们「加载」，那样就测不到限速了
    'Cache-Control': 'no-store'
  }
  if (range) {
    headers['Content-Range'] = `bytes ${start}-${end}/${total}`
    headers['Content-Length'] = String(end - start + 1)
    res.writeHead(206, headers)
  } else {
    headers['Content-Length'] = String(total)
    res.writeHead(200, headers)
  }

  const fd = openSync(file, 'r')
  // 块大小跟速率挂钩，快源用大块、慢源用小块，免得慢源等得离谱
  const chunk = Number.isFinite(rate)
    ? Math.max(4096, Math.min(65536, Math.round(rate / 8) || 4096))
    : 65536
  let offset = start
  let closed = false
  const release = () => {
    if (closed) return
    closed = true
    try {
      closeSync(fd)
    } catch {
      /* ignore */
    }
  }
  res.on('close', release)

  const pump = () => {
    if (closed || res.destroyed) {
      release()
      return
    }
    if (offset > end) {
      release()
      res.end()
      return
    }
    const length = Math.min(chunk, end - offset + 1)
    const buffer = Buffer.allocUnsafe(length)
    readSync(fd, buffer, 0, length, offset)
    offset += length
    const wait = Number.isFinite(rate) ? (length / rate) * 1000 : 0
    if (res.write(buffer)) setTimeout(pump, wait)
    else res.once('drain', () => setTimeout(pump, wait))
  }
  pump()
}

/** 记录所有请求携带的 Referer，用来验证主进程的防盗链补偿是否真的生效 */
const seenReferers = []

const server = createServer((req, res) => {
  const rel = decodeURIComponent((req.url || '/').split('?')[0])
  if (req.headers.referer) seenReferers.push(req.headers.referer)

  /**
   * 「分享页」夹具：返回的是 HTML，真正的播放地址写在页面脚本里，而且是**相对路径**。
   *
   * 这正是「分享页」式来源的形态（页面地址不带媒体扩展名）：
   * 浏览器里能播，是因为页面里藏着 m3u8；播放器必须自己把它挖出来，
   * 直接把这个地址丢给 hls.js 只会得到 manifest 解析错误。
   *
   * 页面里刻意混入广告跳转地址与图片，用来验证解析器不会被它们骗走。
   */
  if (rel.startsWith('/share/')) {
    const page = `<!doctype html>
<html><head><meta charset="utf-8"><title>分享页夹具</title></head>
<body onload="init()">
<div id="a1"></div>
<script src="/js/share.js"></script>
<script type="text/javascript">
    var video_player = 'artplayer'
    var redirecturl = "http://ad.example.com";
    var tracker_url = ''
    var thumbnails = "\\/uploads\\/videos\\/original.mp4\\/thumbnails.jpg";
    var pic = "\\/vod\\/9f8e\\/1.jpg";
    var main = "\\/index.m3u8";
</script>
</body></html>`
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store'
    })
    res.end(page)
    return
  }

  // 低于实时码率：缓冲追不上播放，用来观察「加载中的反馈」。
  // 不能调太狠 —— 太低的话 12 秒观测窗口内几乎下不到东西，「缓冲在增长」就断言不出来。
  if (rel === '/buffer.mp4') {
    serveFile(req, res, SLOW_FILE, CONTENT_BYTES_PER_SEC * 0.8)
    return
  }
  // 够快，但相对「只等两个微任务」的断言窗口依旧远不够下载完，用来验证跳转是否即时。
  // `/seek-<runid>.mp4` 是「跳过片头」用例专用的每轮唯一地址：片头配置按播放地址归组，
  // 地址唯一，上一轮留下的配置就绝不会影响这一轮（这个 userData 目录是跨轮复用的）。
  if (rel === '/seek.mp4' || /^\/seek-[a-z0-9]+\.mp4$/.test(rel)) {
    serveFile(req, res, SLOW_FILE, CONTENT_BYTES_PER_SEC * 6)
    return
  }
  // 对照组：同一个 http 通路、同一份素材，但不限速
  if (rel === '/plain.mp4') {
    serveFile(req, res, SLOW_FILE, Number.POSITIVE_INFINITY)
    return
  }
  // 限速 HLS：分片低于实时码率 → 反复卡顿，遮罩能稳定挂住，
  // 用来截一张**带网络速度读数**的图（原生 mp4 拿不到字节级吞吐，只有 hls.js 有）。
  // 播放列表本身很小，照常全速，否则连不上流。
  if (rel.startsWith('/hls-slow/')) {
    const name = rel.slice('/hls-slow/'.length)
    const file = resolve(DIR, name)
    if (!file.startsWith(resolve(DIR) + sep) || !existsSync(file)) {
      res.writeHead(404).end('not found')
      return
    }
    const isPlaylist = name.endsWith('.m3u8')
    // 分片压到实时码率的 0.3 倍：缓冲追不上播放，遮罩会**长时间挂着**；
    // 播放列表本身很小，给个温和限速（有耗时才有可测的吞吐），别限死否则连不上流。
    serveFile(req, res, file, isPlaylist ? 8192 : CONTENT_BYTES_PER_SEC * 0.3, MIME[extname(file)] ?? 'application/octet-stream')
    return
  }

  const file = resolve(SERVE_ROOT, rel.replace(/^[/\\]+/, ''))
  if (!file.startsWith(SERVE_ROOT + sep) || !existsSync(file)) {
    res.writeHead(404).end('not found')
    return
  }
  // 刻意不设置 Access-Control-Allow-Origin
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' })
  res.end(readFileSync(file))
})
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve))

/* ------------------------------------------------------------------ *
 * 3. 启动应用（隔离 userData）
 * ------------------------------------------------------------------ */

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

let electronLog = ''
electron.stdout.on('data', (c) => (electronLog += c.toString()))
electron.stderr.on('data', (c) => (electronLog += c.toString()))

async function waitForTarget(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
      const list = await res.json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      /* not up yet */
    }
    await delay(400)
  }
  throw new Error('等待调试目标超时')
}

/**
 * 额外的事件监听（截图要用 screencast 推上来的帧）。
 * 与日志采集并存：日志回调照旧，另开一个钩子互不覆盖。
 */
let extraEventHandler = null

/**
 * 取一张**当前**画面的截图，返回 base64。
 *
 * 不用 `Page.captureScreenshot`：本机是无 GPU 的虚拟桌面，它不但慢（~300ms），
 * 还经常交回一帧很旧的画面 —— 截图会「证明」一件早就不是事实的事。
 * screencast 是让渲染器主动推一帧过来，拿到的必定是当下画面，且有超时兜底。
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

function connect(wsUrl, onEvent) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl)
    let nextId = 1
    const pending = new Map()
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.method) {
        onEvent?.(message)
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

async function evaluate(cdp, expression, timeoutMs = 60000) {
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

/**
 * 与 `evaluate` 的唯一区别：**不带 `userGesture`**。
 *
 * 这一条是「自动播放」用例的命门：CDP 的 `userGesture: true` 会给文档授予
 * 「粘性激活」（sticky activation），一旦授予就**撤不回来** —— 之后页面里再调
 * `video.play()` 必然成功。也就是说：只要冒烟脚本早先发过任意一条
 * `userGesture: true`，后面测「能不能自动播放」就必然是假绿。
 *
 * 所以自动播放用例必须放在**最前面**，并且用这个不带手势的版本发起。
 */
async function evaluateNoGesture(cdp, expression, timeoutMs = 60000) {
  const result = await Promise.race([
    cdp.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: false
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

/**
 * 断言「进播放页后不点任何东西也能自己播起来」。
 *
 * ⚠️ 全程只用 `evaluateNoGesture`：一旦发过一条 `userGesture: true`，
 * 文档就永久获得粘性激活，这个用例会变成**永远通过**的假绿（见上面的注释）。
 *
 * 探测体里刻意不调用 `video.play()` —— currentTime 能推进就只可能是页面自己播的。
 */
async function assertAutoplay(label, url, timeoutMs = 25000) {
  await evaluateNoGesture(
    cdp,
    `location.hash = '#/play?path=' + encodeURIComponent(${JSON.stringify(url)})` +
      ` + '&title=' + encodeURIComponent(${JSON.stringify(label)})`
  )
  const probe = await evaluateNoGesture(
    cdp,
    `(async () => {
      const deadline = Date.now() + ${timeoutMs}
      let last = {}
      while (Date.now() < deadline) {
        const video = document.querySelector('video')
        if (video) {
          last = {
            paused: video.paused,
            currentTime: video.currentTime,
            readyState: video.readyState,
            duration: video.duration,
            width: video.videoWidth,
            muted: video.muted,
            volume: video.volume,
            hasBeenActive: navigator.userActivation?.hasBeenActive ?? null,
            fallbackVisible: !!document.querySelector('.player__autoplay'),
            preparing: !!document.querySelector('.player__prepare'),
            fatal: (document.querySelector('.player__error')?.textContent || '').trim(),
            error: video.error ? video.error.code : null
          }
          if (!video.paused && video.currentTime > 0.3 && video.videoWidth > 0) {
            return { ok: true, ...last }
          }
        }
        await new Promise((r) => setTimeout(r, 200))
      }
      return { ok: false, ...last }
    })()`,
    timeoutMs + 8000
  )

  record(
    label,
    probe.ok === true && probe.hasBeenActive === false,
    probe.ok
      ? `已播至=${probe.currentTime.toFixed(2)}s 分辨率=${probe.width} 静音=${probe.muted}` +
        ` 文档已被激活=${probe.hasBeenActive}（须为 false，否则用例无意义）`
      : `暂停=${probe.paused} currentTime=${probe.currentTime?.toFixed?.(2) ?? probe.currentTime}` +
        ` readyState=${probe.readyState} duration=${probe.duration} 宽度=${probe.width}` +
        ` 静音=${probe.muted} 音量=${probe.volume} 文档已被激活=${probe.hasBeenActive}` +
        ` err=${probe.error} 转码中=${probe.preparing} 报错="${probe.fatal}"` +
        ` 补救入口可见=${probe.fallbackVisible}`
  )

  return probe
}

const BASE = `http://127.0.0.1:${PORT}`

/**
 * 注入到页面里的「确保控件可见」小工具。
 *
 * 播放时控件会自动隐藏（`v-show` → `display: none`），此时 `.player__progress`
 * 的 `getBoundingClientRect()` **全是 0** —— 用它换算点击位置会一律落到 0%，
 * 表现为「点了进度条但滑块跑到最左边」，看起来像产品 bug，其实是测量前提没满足。
 * （真实用户点不到隐藏的控件，所以这纯粹是合成事件的测试问题。）
 */
const ENSURE_CONTROLS = `
  const ensureControls = async () => {
    const root = document.querySelector('.player')
    const box = root?.getBoundingClientRect()
    // 注意是 mousemove：控件显隐挂在根节点的 @mousemove 上，
    // 合成一个 pointermove 不会触发它（进度条自己也监听 pointermove，但只在拖拽中才 showControls）
    root?.dispatchEvent(new MouseEvent('mousemove', {
      clientX: (box?.left ?? 0) + 10,
      clientY: (box?.top ?? 0) + 10,
      bubbles: true
    }))
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    return document.querySelector('.player__progress').getBoundingClientRect()
  }
`

let cdp
/** 浏览器控制台（含媒体内核的真实报错原因），排查解码失败时全靠它 */
const consoleLog = []
try {
  const target = await waitForTarget()
  cdp = await connect(target.webSocketDebuggerUrl, (message) => {
    if (message.method === 'Log.entryAdded') {
      const entry = message.params?.entry
      if (entry) consoleLog.push(`[${entry.level}] ${entry.text}`)
      return
    }
    // hls.js 的内部报错走的是 console.error，只有 Runtime.consoleAPICalled 抓得到。
    // 上面那个 Log.entryAdded 是浏览器级日志（网络/安全），拿不到页面里的 console 调用。
    if (message.method === 'Runtime.consoleAPICalled') {
      const type = message.params?.type ?? 'log'
      const text = (message.params?.args ?? [])
        .map((arg) => (arg.value !== undefined ? String(arg.value) : (arg.description ?? arg.type ?? '')))
        .join(' ')
      if (text) consoleLog.push(`[console.${type}] ${text}`)
    }
  })
  await cdp.send('Runtime.enable')
  await cdp.send('Log.enable')
  await delay(2000)

  /* ---------- A0. 自动播放：进播放页后不点任何东西也要自己播起来 ---------- *
   *
   * ⚠️ 这一段必须排在所有 `userGesture: true` 之前，且全程只用 `evaluateNoGesture`。
   * 原因见它的注释：一旦文档被授予过「粘性激活」，自动播放**必然**成功，
   * 这个用例就永远测不出「每次都要手动点一下才有画面」这个真实缺陷。
   *
   * 背景（实测结论，别再走一遍弯路）：Electron 的 `webPreferences.autoplayPolicy`
   * **默认就是放开的**，所以自动播放失败**不是**主进程策略问题 ——
   * 把策略显式设成 `document-user-activation-required` 才会（可复现地）拦下自动播放，
   * 那是用来验证本条用例「真的能翻红」的反向实验，不是产品配置。
   * 因此这里按**片源形态**逐条覆盖：直链 mp4 / HLS / 需要 cine-file:// 的本地文件，
   * 任何一条播不起来，都是应用自身起播链路的问题。
   */

  // 前提：此刻文档确实「从未被激活过」，否则下面的断言全是假的
  const activationProbe = await evaluateNoGesture(
    cdp,
    `({
      hasBeenActive: navigator.userActivation?.hasBeenActive ?? null,
      isActive: navigator.userActivation?.isActive ?? null,
      supported: typeof navigator.userActivation !== 'undefined'
    })`
  )

  await evaluateNoGesture(
    cdp,
    `location.hash = '#/play?path=' + encodeURIComponent(${JSON.stringify(`${BASE}/plain.mp4`)}) + '&title=%E8%87%AA%E5%8A%A8%E6%92%AD%E6%94%BE'`
  )

  // 全程不调用 video.play()：能推进就一定是页面自己播起来的
  const autoplay = await evaluateNoGesture(
    cdp,
    `(async () => {
      const deadline = Date.now() + 25000
      let last = {}
      while (Date.now() < deadline) {
        const video = document.querySelector('video')
        if (video) {
          last = {
            paused: video.paused,
            currentTime: video.currentTime,
            readyState: video.readyState,
            duration: video.duration,
            width: video.videoWidth,
            hasBeenActive: navigator.userActivation?.hasBeenActive ?? null,
            fallbackVisible: !!document.querySelector('.player__autoplay'),
            error: video.error ? video.error.code : null
          }
          if (!video.paused && video.currentTime > 0.3 && video.videoWidth > 0) {
            return { ok: true, ...last }
          }
        }
        await new Promise((r) => setTimeout(r, 250))
      }
      return { ok: false, ...last }
    })()`
  )

  record(
    '自动播放用例的前提：文档此刻从未有过用户手势',
    activationProbe.supported === true && activationProbe.hasBeenActive === false,
    JSON.stringify(activationProbe)
  )

  record(
    '进入播放页后无需任何点击即自动播放',
    autoplay.ok === true && autoplay.hasBeenActive === false,
    autoplay.ok
      ? `暂停=${autoplay.paused} 已播至=${autoplay.currentTime.toFixed(2)}s 分辨率=${autoplay.width}` +
        ` 文档已被激活=${autoplay.hasBeenActive}（必须为 false，否则用例无意义）`
      : `暂停=${autoplay.paused} currentTime=${autoplay.currentTime?.toFixed?.(2) ?? autoplay.currentTime}` +
        ` readyState=${autoplay.readyState} duration=${autoplay.duration} 宽度=${autoplay.width}` +
        ` 文档已被激活=${autoplay.hasBeenActive} err=${autoplay.error}` +
        ` 补救入口可见=${autoplay.fallbackVisible}`
  )

  record(
    '自动播放成功时不应出现「点击播放」补救入口',
    autoplay.ok === true && autoplay.fallbackVisible === false,
    `补救入口可见=${autoplay.fallbackVisible}`
  )

  // 同一件事要在**每一种片源形态**上都成立 —— 直链只跑通一种不代表用户那条路没问题
  await assertAutoplay('HLS 直播流进页面即自动播放（无需点击）', `${BASE}/index.m3u8`)
  await assertAutoplay('本地文件（cine-file://）进页面即自动播放（无需点击）', `${ROOT}/.smoke/noaudio.mp4`)

  /*
   * ⚠️ 有声素材单独测：Chromium 自动播放策略真正的门槛是**发声**媒体，
   * 而本项目所有夹具出于环境限制都是 `-an` 静音的 —— 只用静音素材测，
   * 「自动播放」这条链路其实从没被真正验证过。
   *
   * 判据只看**是否被策略拒绝**（`NotAllowedError`）。本机音频渲染器起不来，
   * 媒体随后会以 MEDIA_ERR_DECODE 收场，那是环境问题、与策略无关，不作断言。
   */
  const audible = await evaluateNoGesture(
    cdp,
    `(async () => {
      const video = document.createElement('video')
      video.src = ${JSON.stringify(`${BASE}/h264-aac.mp4`)}
      video.muted = false
      document.body.appendChild(video)
      let outcome = 'pending'
      try {
        await video.play()
        outcome = 'resolved'
      } catch (error) {
        outcome = 'rejected:' + (error && error.name ? error.name : String(error))
      }
      const result = {
        outcome,
        muted: video.muted,
        volume: video.volume,
        hasBeenActive: navigator.userActivation?.hasBeenActive ?? null,
        error: video.error ? video.error.code : null
      }
      video.remove()
      return result
    })()`,
    20000
  )
  record(
    '有声素材没有被自动播放策略拒绝（本机音频渲染器不可用，只能验证「未被策略拦」这一半）',
    audible.outcome !== 'pending' && !String(audible.outcome).startsWith('rejected:NotAllowed'),
    `结果=${audible.outcome} 静音=${audible.muted} 音量=${audible.volume}` +
      ` 文档已被激活=${audible.hasBeenActive} 媒体错误码=${audible.error}`
  )

  /* ---------- A. 跨域头注入 ---------- */
  const cors = await evaluate(
    cdp,
    `(async () => {
      const res = await fetch(${JSON.stringify(`${BASE}/index.m3u8`)})
      const text = await res.text()
      return { status: res.status, hasTag: text.includes('#EXTM3U'), len: text.length }
    })()`
  )
  record(
    '渲染层可直接拉取无 CORS 头的 IPTV 资源',
    cors.status === 200 && cors.hasTag,
    `status=${cors.status} 字符数=${cors.len}`
  )

  /* ---------- B. live:playlist IPC ---------- */
  const playlist = await evaluate(
    cdp,
    `window.api.live.fetchPlaylist(${JSON.stringify(`${BASE}/list.m3u`)})`
  )
  const channelCount = playlist.ok ? (playlist.content.match(/#EXTINF/g) || []).length : 0
  record(
    'live:playlist 拉取 M3U 订阅',
    playlist.ok === true && channelCount === 4 && playlist.content.includes('group-title="央视"'),
    playlist.ok ? `${playlist.content.length} 字符，解析出 ${channelCount} 个频道` : playlist.error
  )

  const playlist404 = await evaluate(
    cdp,
    `window.api.live.fetchPlaylist(${JSON.stringify(`${BASE}/nope.m3u`)})`
  )
  record(
    'live:playlist 对无效地址给出可读错误',
    playlist404.ok === false && !!playlist404.error,
    playlist404.error
  )

  const playlistBadScheme = await evaluate(cdp, `window.api.live.fetchPlaylist('rtmp://example.com/live')`)
  record(
    'live:playlist 拒绝非 http 协议',
    playlistBadScheme.ok === false,
    playlistBadScheme.error
  )

  /* ---------- C. epg:fetch IPC ---------- */
  const epg = await evaluate(cdp, `window.api.epg.fetch(${JSON.stringify(`${BASE}/epg.xml`)})`)
  record(
    'epg:fetch 解析 XMLTV 节目单',
    epg.ok === true && epg.programmeCount >= 3 && epg.channelCount === 2,
    `频道=${epg.channelCount} 节目=${epg.programmeCount}`
  )

  /* ---------- D. hls.js 真实播放 ---------- */
  const playUrl = `${BASE}/index.m3u8`
  await evaluate(
    cdp,
    `location.hash = '#/play?path=' + encodeURIComponent(${JSON.stringify(playUrl)}) + '&title=HLS%E6%B5%8B%E8%AF%95'`
  )
  await delay(1500)

  const live = await evaluate(
    cdp,
    `(async () => {
      const video = document.querySelector('video')
      if (!video) return { ok: false, message: '播放器未渲染' }
      const deadline = Date.now() + 25000
      while (Date.now() < deadline) {
        if (video.currentTime > 0.5 && video.videoWidth > 0) {
          return { ok: true, advanced: video.currentTime, width: video.videoWidth, height: video.videoHeight, src: video.src.slice(0, 60) }
        }
        await new Promise((r) => setTimeout(r, 250))
      }
      return {
        ok: false,
        message:
          'HLS 未产生播放进度 currentTime=' + video.currentTime +
          ' readyState=' + video.readyState + ' networkState=' + video.networkState +
          ' err=' + (video.error && video.error.code) + '(' + (video.error ? video.error.message : '') + ')' +
          ' 播放器提示="' + (document.querySelector('.player__error')?.textContent || '').trim() + '"',
        width: video.videoWidth
      }
    })()`
  )
  record(
    'hls.js 播放 m3u8 直播流',
    live.ok === true && live.width === 640,
    live.ok ? `分辨率=${live.width}x${live.height} 已播至=${live.advanced?.toFixed(2)}s` : live.message
  )
  if (!live.ok) {
    console.log('  --- 控制台尾部（找 hls.js / MSE 报错原因） ---')
    for (const line of consoleLog.slice(-12)) console.log(`  ${line.slice(0, 220)}`)
  }

  /* ---------- D2. 对照组：http 直链 mp4 本身能不能播 ---------- */
  await evaluate(
    cdp,
    `location.hash = '#/play?path=' + encodeURIComponent(${JSON.stringify(`${BASE}/plain.mp4`)}) + '&title=HTTP%E7%9B%B4%E9%93%BE'`
  )
  const plain = await evaluate(
    cdp,
    `(async () => {
      const deadline = Date.now() + 20000
      let last = {}
      while (Date.now() < deadline) {
        const video = document.querySelector('video')
        if (video) {
          last = {
            readyState: video.readyState,
            networkState: video.networkState,
            paused: video.paused,
            error: video.error ? video.error.code : null,
            errorMessage: video.error ? video.error.message : '',
            currentTime: video.currentTime,
            duration: video.duration,
            width: video.videoWidth
          }
          if (video.currentTime > 0.3 && video.videoWidth > 0) return { ok: true, ...last }
        }
        await new Promise((r) => setTimeout(r, 250))
      }
      return {
        ok: false,
        ...last,
        message: (document.querySelector('.player__error')?.textContent || '').trim()
      }
    })()`
  )
  record(
    'HTTP 直链 mp4 能播（对照组：失败即说明本环境 http 媒体通路有问题）',
    plain.ok === true,
    plain.ok
      ? `已播至=${plain.currentTime.toFixed(2)}s 分辨率=${plain.width} 时长=${plain.duration}`
      : `readyState=${plain.readyState} networkState=${plain.networkState} paused=${plain.paused}` +
        ` err=${plain.error}(${plain.errorMessage}) duration=${plain.duration} 宽度=${plain.width} 提示="${plain.message ?? ''}"`
  )
  if (!plain.ok) {
    console.log('  --- 控制台尾部（找媒体内核报错原因） ---')
    for (const line of consoleLog.slice(-12)) console.log(`  ${line.slice(0, 220)}`)
  }

  /* ---------- D3. 分享页地址：网页里藏着 m3u8 ---------- */
  const SHARE_PAGE = `${BASE}/share/abc123def456`

  // 先看主进程解析得对不对（这一步不发媒体请求，纯解析）
  const resolved = await evaluate(
    cdp,
    `window.api.stream.resolve(${JSON.stringify(SHARE_PAGE)})`
  )
  record(
    '分享页地址被解析成真实 m3u8 地址',
    resolved?.ok === true &&
      resolved.from === 'page' &&
      resolved.url === `${BASE}/index.m3u8`,
    JSON.stringify(resolved)
  )

  // 再走真实的播放链路：把网页地址丢进播放页，看它能不能自己播出画面
  await evaluate(
    cdp,
    `location.hash = '#/play?path=' + encodeURIComponent(${JSON.stringify(SHARE_PAGE)}) + '&title=%E5%88%86%E4%BA%AB%E9%A1%B5'`
  )
  const sharePlay = await evaluate(
    cdp,
    `(async () => {
      const deadline = Date.now() + 25000
      let sawResolveLabel = false
      let last = {}
      while (Date.now() < deadline) {
        const video = document.querySelector('video')
        const label = document.querySelector('.player__loading-label')?.textContent?.trim() ?? ''
        if (label.includes('正在解析播放地址')) sawResolveLabel = true
        if (video) {
          last = {
            readyState: video.readyState,
            error: video.error ? video.error.code : null,
            errorMessage: video.error ? video.error.message : '',
            currentTime: video.currentTime,
            width: video.videoWidth
          }
          if (video.currentTime > 0.3 && video.videoWidth > 0) {
            return { ok: true, sawResolveLabel, ...last }
          }
        }
        await new Promise((r) => setTimeout(r, 250))
      }
      return {
        ok: false,
        sawResolveLabel,
        ...last,
        message: (document.querySelector('.player__error')?.textContent || '').trim()
      }
    })()`
  )
  record(
    '播放页里直接填分享页地址也能播起来（用户不用手动找 m3u8）',
    sharePlay.ok === true,
    sharePlay.ok
      ? `已播至=${sharePlay.currentTime.toFixed(2)}s 分辨率=${sharePlay.width} 期间出现过解析提示=${sharePlay.sawResolveLabel}`
      : `readyState=${sharePlay.readyState} err=${sharePlay.error}(${sharePlay.errorMessage}) ` +
        `宽度=${sharePlay.width} 提示="${sharePlay.message ?? ''}"`
  )
  if (!sharePlay.ok) {
    console.log('  --- 控制台尾部（找分享页解析失败原因） ---')
    for (const line of consoleLog.slice(-12)) console.log(`  ${line.slice(0, 220)}`)
  }

  // 留一张证据：地址栏填的是网页地址，画面却是真的在播
  try {
    const shotDir = `${ROOT}/.smoke/shots`
    mkdirSync(shotDir, { recursive: true })
    const data = await captureFrame(cdp)
    if (data) {
      writeFileSync(`${shotDir}/share-page.png`, Buffer.from(data, 'base64'))
      console.log('  截图已保存：.smoke/shots/share-page.png（播放页里直接填分享页地址，画面已在播）')
    }
  } catch (error) {
    console.log(`  截图失败（不影响用例结论）：${error?.message ?? error}`)
  }

  // 防盗链补偿：解析出来的流，后续同源请求要带上分享页地址作为 Referer
  record(
    '解析出的流自动补上分享页 Referer（防盗链）',
    seenReferers.includes(SHARE_PAGE),
    `已见 Referer=${JSON.stringify([...new Set(seenReferers)].slice(0, 4))}`
  )

  /* ---------- E. RTMP 给出明确提示 ---------- */
  await evaluate(cdp, `location.hash = '#/play?path=' + encodeURIComponent('rtmp://live.example.com/app/key')`)
  await delay(1200)
  const rtmpMsg = await evaluate(
    cdp,
    `(async () => {
      for (let i = 0; i < 40; i++) {
        const text = document.body.innerText || ''
        if (text.includes('RTMP') || text.includes('rtmp')) return text.match(/[^\\n]*RTMP[^\\n]*/i)?.[0] ?? 'found'
        await new Promise((r) => setTimeout(r, 200))
      }
      return ''
    })()`
  )
  record('RTMP 地址给出明确不可播提示', !!rtmpMsg, rtmpMsg)

  /* ---------- F. 限速源跳转：加载遮罩 + 进度读数（用户报的正是这个场景） ---------- */
  await evaluate(
    cdp,
    `location.hash = '#/play?path=' + encodeURIComponent(${JSON.stringify(`${BASE}/buffer.mp4`)}) + '&title=%E9%99%90%E9%80%9F%E6%BA%90'`
  )
  await delay(1200)

  const seekFeedback = await evaluate(
    cdp,
    `(async () => {
      ${ENSURE_CONTROLS}
      const bar = document.querySelector('.player__progress')
      const video = document.querySelector('video')
      if (!bar || !video) return { ok: false, message: '播放器未渲染' }

      const waitMetadata = Date.now() + 25000
      while (Date.now() < waitMetadata && !(video.duration > 1)) await new Promise((r) => setTimeout(r, 200))
      if (!(video.duration > 1)) return { ok: false, message: '拿不到时长 duration=' + video.duration }

      const totalBuffered = () => {
        let sum = 0
        for (let i = 0; i < video.buffered.length; i++) sum += video.buffered.end(i) - video.buffered.start(i)
        return sum
      }
      const ranges = () => {
        const out = []
        for (let i = 0; i < Math.min(video.buffered.length, 4); i++) {
          out.push([+video.buffered.start(i).toFixed(1), +video.buffered.end(i).toFixed(1)])
        }
        return out
      }
      /** 采样一次全部可观测状态 —— 失败时靠这条时间线定位，而不是靠猜 */
      const snap = (tag) => ({
        tag,
        thumb: parseFloat(document.querySelector('.player__progress-thumb')?.style.left) || 0,
        now: +video.currentTime.toFixed(2),
        dur: +video.duration.toFixed(2),
        bufTotal: +totalBuffered().toFixed(2),
        ranges: ranges(),
        mask: !!document.querySelector('.player__loading'),
        label: document.querySelector('.player__loading-label')?.textContent?.trim() ?? '',
        stats: document.querySelector('.player__loading-stats')?.textContent?.trim() ?? ''
      })

      const beforeSeconds = totalBuffered()
      const timeline = [snap('before')]

      // 跳到 80%（先确保控件可见，否则 rect 全 0，点击会被算成 0%）
      const rect = await ensureControls()
      const x = rect.left + rect.width * 0.8
      const y = rect.top + rect.height / 2
      bar.dispatchEvent(new PointerEvent('pointerdown', { clientX: x, clientY: y, bubbles: true, pointerId: 1 }))
      bar.dispatchEvent(new PointerEvent('pointerup', { clientX: x, clientY: y, bubbles: true, pointerId: 1 }))

      // 只让 Vue 调度器跑完就取一次滑块位置 —— 这点时间下不到任何分片
      await Promise.resolve()
      await Promise.resolve()
      await new Promise((r) => setTimeout(r, 0))
      const thumbAtClick = parseFloat(document.querySelector('.player__progress-thumb')?.style.left) || 0

      let sawOverlay = false
      let sawSeekLabel = false
      let label = ''
      let stats = ''
      const deadline = Date.now() + 12000
      let nextSample = Date.now() + 1000
      while (Date.now() < deadline) {
        const overlay = document.querySelector('.player__loading')
        if (overlay) {
          sawOverlay = true
          label = document.querySelector('.player__loading-label')?.textContent?.trim() ?? label
          stats = document.querySelector('.player__loading-stats')?.textContent?.trim() ?? stats
          if (label.includes('正在跳转')) sawSeekLabel = true
        }
        if (Date.now() >= nextSample) {
          timeline.push(snap('t+' + timeline.length))
          nextSample = Date.now() + 1000
        }
        await new Promise((r) => setTimeout(r, 100))
      }

      return {
        ok: true,
        sawOverlay,
        sawSeekLabel,
        label,
        stats,
        thumbAtClick,
        beforeSeconds,
        afterSeconds: totalBuffered(),
        timeline
      }
    })()`
  )

  record(
    '限速源上点进度条：滑块立刻到点击位置，并弹出带读数（网络速度/已缓冲）的加载遮罩',
    seekFeedback.ok === true &&
      seekFeedback.thumbAtClick >= 79 &&
      seekFeedback.sawSeekLabel === true &&
      seekFeedback.stats.includes('已缓冲'),
    seekFeedback.ok
      ? `点击瞬间滑块=${seekFeedback.thumbAtClick.toFixed(1)}% 文案含「正在跳转到」=${seekFeedback.sawSeekLabel}` +
        ` 最后一次读数="${seekFeedback.label} / ${seekFeedback.stats}"`
      : seekFeedback.message
  )
  if (seekFeedback.ok) {
    console.log('  时间线（每 1s 采样：滑块% / 播放头 / 时长 / 已缓冲秒 / 缓冲区间 / 遮罩 / 文案）')
    for (const s of seekFeedback.timeline) {
      console.log(
        `    ${s.tag.padEnd(6)} ${String(s.thumb).padStart(5)}%  now=${String(s.now).padStart(6)}` +
          `  dur=${s.dur}  buf=${String(s.bufTotal).padStart(5)}s  ranges=${JSON.stringify(s.ranges)}` +
          `  mask=${s.mask}  "${s.label}"`
      )
    }
  }

  record(
    '进度条显示已缓冲区间，且随下载持续增长',
    seekFeedback.ok === true && seekFeedback.afterSeconds > seekFeedback.beforeSeconds + 1,
    seekFeedback.ok
      ? `已缓冲 ${seekFeedback.beforeSeconds.toFixed(1)}s → ${seekFeedback.afterSeconds.toFixed(1)}s`
      : seekFeedback.message
  )

  /* ---------- G. 点击进度条：立刻跳到点击位置 ---------- */
  await evaluate(
    cdp,
    `location.hash = '#/play?path=' + encodeURIComponent(${JSON.stringify(`${BASE}/seek.mp4`)}) + '&title=%E8%B7%B3%E8%BD%AC%E6%B5%8B%E8%AF%95'`
  )
  await delay(1200)

  const immediate = await evaluate(
    cdp,
    `(async () => {
      ${ENSURE_CONTROLS}
      const bar = document.querySelector('.player__progress')
      const video = document.querySelector('video')
      if (!bar || !video) return { ok: false, message: '播放器未渲染' }

      const deadline = Date.now() + 20000
      while (Date.now() < deadline && !(video.duration > 1)) await new Promise((r) => setTimeout(r, 200))
      if (!(video.duration > 1)) return { ok: false, message: '拿不到时长 duration=' + video.duration }

      const ratio = 0.6
      const thumbBefore = parseFloat(document.querySelector('.player__progress-thumb').style.left) || 0
      const timeBefore = document.querySelector('.player__time')?.textContent?.trim() ?? ''
      // 断言窗口内的缓冲上界 —— 用来旁证「数据确实还没下到目标位置」
      const bufferedEnd = video.buffered.length ? video.buffered.end(video.buffered.length - 1) : 0

      const rect = await ensureControls()
      const x = rect.left + rect.width * ratio
      const y = rect.top + rect.height / 2
      bar.dispatchEvent(new PointerEvent('pointerdown', { clientX: x, clientY: y, bubbles: true, pointerId: 1 }))
      bar.dispatchEvent(new PointerEvent('pointerup', { clientX: x, clientY: y, bubbles: true, pointerId: 1 }))

      // 只让 Vue 的调度器跑完（微任务 + 0ms 宏任务）：
      // 这点时间连一个分片都下不下来，界面要是动了就只能是「乐观更新」
      await Promise.resolve()
      await Promise.resolve()
      await new Promise((r) => setTimeout(r, 0))

      const thumbAfter = parseFloat(document.querySelector('.player__progress-thumb').style.left) || 0
      const timeAfter = document.querySelector('.player__time')?.textContent?.trim() ?? ''

      // 遮罩可能一闪而过，用轮询把它抓下来（同时记录文案与「已缓冲」读数）
      let overlaySeen = false
      let label = ''
      let statsText = ''
      /* 顺带把透明度也记下来：「入场过渡卡在 enter-from 上」那种坑会让遮罩**真的透明**，
         可它的 getBoundingClientRect 依然非零 —— 只查存在性会一路绿灯，但用户什么都看不见。
         （注意：本段处在模板字符串里，注释里不能出现反引号，否则会把模板提前截断。） */
      let overlayOpacity = 0
      const pollUntil = Date.now() + 6000
      while (Date.now() < pollUntil) {
        const overlay = document.querySelector('.player__loading')
        if (overlay) {
          overlaySeen = true
          // 取观察到的**峰值**：淡入过程中会读到 0.3、0.7 这种中间值，
          // 只有「一直涨不到 1」才说明它真的卡在透明态
          overlayOpacity = Math.max(overlayOpacity, Number.parseFloat(getComputedStyle(overlay).opacity))
          label = document.querySelector('.player__loading-label')?.textContent?.trim() ?? label
          statsText = document.querySelector('.player__loading-stats')?.textContent?.trim() ?? statsText
        }
        if (overlaySeen && statsText && overlayOpacity > 0.9) break
        await new Promise((r) => setTimeout(r, 20))
      }

      return {
        ok: true,
        duration: video.duration,
        thumbBefore,
        thumbAfter,
        timeBefore,
        timeAfter,
        overlaySeen,
        overlayOpacity,
        label,
        statsText,
        bufferedEnd,
        currentTime: video.currentTime,
        children: [...document.querySelector('.player').children].map((el) => el.className),
        errorText: document.querySelector('.player__error')?.textContent?.trim() ?? '',
        paused: video.paused,
        readyState: video.readyState,
        networkState: video.networkState,
        errorCode: video.error ? video.error.code : null
      }
    })()`
  )

  const targetPercent = 60
  record(
    '点击进度条后滑块立即跳到点击位置（不等下载）',
    immediate.ok === true &&
      Math.abs(immediate.thumbAfter - targetPercent) <= 6 &&
      Math.abs(immediate.thumbBefore - targetPercent) > 6,
    immediate.ok
      ? `滑块 ${immediate.thumbBefore.toFixed(1)}% → ${immediate.thumbAfter.toFixed(1)}%（点击 ${targetPercent}%）` +
        ` 时间 ${immediate.timeBefore} → ${immediate.timeAfter}` +
        ` 当时已缓冲至 ${immediate.bufferedEnd.toFixed(1)}s / 目标 ${(immediate.duration * 0.6).toFixed(1)}s`
      : immediate.message
  )

  record(
    '跳转期间出现加载遮罩（含进度读数，且真的不透明）',
    immediate.ok === true &&
      immediate.overlaySeen === true &&
      immediate.overlayOpacity > 0.9 &&
      immediate.label.includes('正在跳转') &&
      immediate.statsText.includes('已缓冲'),
    immediate.ok
      ? `遮罩出现=${immediate.overlaySeen} 峰值透明度=${immediate.overlayOpacity} 文案="${immediate.label}" 读数="${immediate.statsText}"` +
        ` | 播放器子元素=${JSON.stringify(immediate.children)} 错误="${immediate.errorText}"` +
        ` paused=${immediate.paused} readyState=${immediate.readyState} networkState=${immediate.networkState} err=${immediate.errorCode}`
      : immediate.message
  )

  const landed = await evaluate(
    cdp,
    `(async () => {
      const video = document.querySelector('video')
      const target = video.duration * 0.6
      const deadline = Date.now() + 30000
      while (Date.now() < deadline) {
        if (Math.abs(video.currentTime - target) < 1.5) return { ok: true, at: video.currentTime, target }
        await new Promise((r) => setTimeout(r, 250))
      }
      return { ok: false, at: video.currentTime, target }
    })()`
  )
  record(
    '跳转最终真的落到目标位置（不是只改了界面）',
    landed.ok === true,
    `目标=${landed.target.toFixed(1)}s 实际=${landed.at.toFixed(2)}s`
  )
  /* ---------- G2. 跳过片头片尾（真实播放 + 真时长） ---------- */
  /**
   * 为什么放在这个套件：跳过片头要靠**真实时长**与真实 seek 落地，
   * 采集站桩数据里的 m3u8 是打不开的（duration 恒为 0），在那里只能测到菜单渲染。
   * `/seek.mp4` 是 6× 实时码率，跳转能在秒级完成，才谈得上断言「跳过去了」。
   */
  const OPEN_DB = `const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open('cineplayer')
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })`

  /**
   * 隔离：这个 userData 目录是**跨轮复用**的，上一轮留下的片头配置会让这一轮的前提不成立。
   * 不靠「清库 + 重载」（清库只动了磁盘，pinia 里那份还在），
   * 而是给本轮用一个**全新的播放地址** —— 配置按地址归组，地址唯一就天然互不干扰。
   */
  await evaluate(
    cdp,
    `location.hash = '#/play?path=' + encodeURIComponent(${JSON.stringify(`${BASE}/seek-${RUN_ID}.mp4`)}) + '&title=%E8%B7%B3%E8%BF%87%E7%89%87%E5%A4%B4'`
  )
  await delay(1200)

  const skipReady = await evaluate(
    cdp,
    `(async () => {
      const deadline = Date.now() + 30000
      while (Date.now() < deadline) {
        const video = document.querySelector('video')
        if (video && video.duration > 1) return { ok: true, duration: video.duration }
        await new Promise((r) => setTimeout(r, 200))
      }
      return {
        ok: false,
        err: document.querySelector('.player__error')?.textContent?.trim() ?? '',
        hasVideo: !!document.querySelector('video')
      }
    })()`
  )
  record('跳过片头的用例前提：拿到真实时长', skipReady.ok === true, `时长=${skipReady.duration ?? '—'} ${skipReady.err || ''}`)

  // 打开「跳过片头片尾」菜单，把播放头拖到 10s，点「设为当前」
  const setIntro = await evaluate(
    cdp,
    `(async () => {
      // 刻意**不用** ensureControls()：它靠 requestAnimationFrame 等两帧，
      // 而窗口被遮挡时 rAF 可能整帧不回调，会把 evaluate 挂到超时。
      // 这里只做 .click()，对 display:none 的元素同样有效，不需要控件先显形。
      const video = document.querySelector('video')
      video.currentTime = 10
      await new Promise((r) => {
        video.addEventListener('seeked', r, { once: true })
        setTimeout(r, 5000)
      })
      const tool = document.querySelector('.player__bar button[title="跳过片头片尾"]')
      if (!tool) return { ok: false, reason: '控制栏里没有「跳过片头片尾」入口' }
      tool.click()
      await new Promise((r) => setTimeout(r, 250))
      const row = document.querySelector('.player__menu [data-skip="intro"]')
      const button = row?.parentElement?.querySelector('.player__skip-set')
      if (!button) return { ok: false, reason: '菜单里没有片头「设为当前」按钮' }
      button.click()
      await new Promise((r) => setTimeout(r, 350))
      return {
        ok: true,
        shown: document.querySelector('[data-skip="intro"]')?.textContent?.trim() ?? '',
        headline: video.currentTime
      }
    })()`
  )
  record(
    '把播放头拖到 10s 后「设为当前」，片头结束点被记下',
    setIntro.ok === true && setIntro.shown === '0:10',
    setIntro.ok ? `菜单显示="${setIntro.shown}" 播放头=${Number(setIntro.headline).toFixed(1)}s` : setIntro.reason
  )

  const persisted = await evaluate(
    cdp,
    `(async () => {
      ${OPEN_DB}
      const rows = await new Promise((resolve, reject) => {
        const tx = db.transaction('skip', 'readonly')
        const req = tx.objectStore('skip').getAll()
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
      return rows.map((row) => ({ key: row.key, introEnd: row.introEnd, outroStart: row.outroStart }))
    })()`
  )
  const savedRow = Array.isArray(persisted)
    ? persisted.find((row) => row.key === `local:${BASE}/seek-${RUN_ID}.mp4`)
    : null
  record(
    '配置真的落到了本地库（不是只改了界面）',
    !!savedRow && Math.abs(savedRow.introEnd - 10) < 1 && savedRow.outroStart === 0,
    savedRow ? `key=${savedRow.key} 片头=${savedRow.introEnd}s 片尾=${savedRow.outroStart}s` : '没读到记录'
  )

  // 拖回片头区间：浮出的「跳过片头」应该出现，点下去要真的跳过去
  const skipClick = await evaluate(
    cdp,
    `(async () => {
      const video = document.querySelector('video')
      // 关掉菜单，免得它挡住浮出按钮
      document.querySelector('.player__video')?.click()
      video.currentTime = 2
      await new Promise((r) => {
        video.addEventListener('seeked', r, { once: true })
        setTimeout(r, 5000)
      })
      await new Promise((r) => setTimeout(r, 200))

      const button = document.querySelector('.player__skip')
      if (!button) return { appeared: false }

      // 淡入 200ms：中途读 getComputedStyle 会拿到 0.3/0.7 的中间值，取峰值才判得准。
      // 透明元素的 getBoundingClientRect 依然非零，「元素存在」这种断言会被蒙过去。
      let peak = 0
      for (let i = 0; i < 14; i++) {
        peak = Math.max(peak, Number.parseFloat(getComputedStyle(button).opacity) || 0)
        await new Promise((r) => setTimeout(r, 30))
      }
      const rect = button.getBoundingClientRect()
      const text = (button.textContent || '').replace(/\\s+/g, ' ').trim()
      button.click()

      const deadline = Date.now() + 12000
      while (Date.now() < deadline && Math.abs(video.currentTime - 10) > 1.5) {
        await new Promise((r) => setTimeout(r, 150))
      }
      return {
        appeared: true,
        text,
        peak,
        inViewport: rect.right <= window.innerWidth + 1 && rect.left >= -1 && rect.bottom <= window.innerHeight + 1,
        at: video.currentTime
      }
    })()`
  )
  record(
    '拖回片头区间后浮出「跳过片头」，且真的可见（不透明 + 在视口内）',
    skipClick.appeared === true && skipClick.peak > 0.9 && skipClick.inViewport === true,
    skipClick.appeared
      ? `文案="${skipClick.text}" 峰值不透明度=${skipClick.peak} 在视口内=${skipClick.inViewport}`
      : '浮出按钮没有出现'
  )
  record(
    '点「跳过片头」确实跳到了片头结束点',
    skipClick.appeared === true && Math.abs(skipClick.at - 10) < 1.5,
    skipClick.appeared ? `点击后播放头=${Number(skipClick.at).toFixed(2)}s（目标 10s）` : '未点击'
  )
  record(
    '没有播放列表时不出现「跳过片尾」（跳过去也无处可去）',
    skipClick.appeared === true && !skipClick.text.includes('片尾'),
    `浮出按钮文案="${skipClick.text ?? '—'}"`
  )

  // 自动跳过：打开开关后，往回拖进片头应当自己弹回正片，且不再显示按钮
  const autoSkip = await evaluate(
    cdp,
    `(async () => {
      document.querySelector('.player__bar button[title="跳过片头片尾"]')?.click()
      await new Promise((r) => setTimeout(r, 250))
      const toggle = document.querySelector('[data-skip="auto-intro"]')
      if (!toggle) return { ok: false, reason: '菜单里没有「自动跳过片头」开关' }
      toggle.click()
      await new Promise((r) => setTimeout(r, 300))
      const on = document.querySelector('[data-skip="auto-intro"] .player__switch')?.classList.contains('is-on') === true
      document.querySelector('.player__video')?.click()

      const video = document.querySelector('video')
      video.currentTime = 1
      const deadline = Date.now() + 12000
      while (Date.now() < deadline && Math.abs(video.currentTime - 10) > 1.5) {
        await new Promise((r) => setTimeout(r, 150))
      }
      return {
        ok: true,
        on,
        at: video.currentTime,
        floating: !!document.querySelector('.player__skip')
      }
    })()`
  )
  record(
    '打开「自动跳过片头」后回到片头会自己弹回正片，且不再显示按钮',
    autoSkip.ok === true && autoSkip.on === true && Math.abs(autoSkip.at - 10) < 1.5 && autoSkip.floating === false,
    autoSkip.ok
      ? `开关=${autoSkip.on} 播放头=${Number(autoSkip.at).toFixed(2)}s 仍在显示浮出按钮=${autoSkip.floating}`
      : autoSkip.reason
  )

  /**
   * 重载应用：配置应当从本地库读回来，并且直接生效。
   *
   * 两个坑都踩过：
   *  1. 用 JS 的 location.reload() 有可能被渲染进程的卸载流程吞掉，于是「重载过了」
   *     这件事本身不成立 —— 先埋一个全局标记，重载后它必须消失，否则整条断言是假绿。
   *  2. **不能**在重载后等几秒再去看画面在不在 10s：视频是自动播放的，
   *     自动跳过发生在元数据就绪后的零点几秒，等 2.5 秒再看它早就跑到十几秒了，
   *     「跳过去了」和「一路播过去的」就分不清。所以一拿到时长**立刻**取样。
   */
  await evaluate(cdp, `window.__skipReloadMark = 1`)
  // 走 CDP 的 Page.reload 而不是 JS 的 location.reload()：前者的回执来自浏览器进程，
  // 不会随渲染进程的卸载一起丢掉
  await cdp.send('Page.enable')
  await cdp.send('Page.reload', { ignoreCache: false })
  await delay(3000)

  const afterReload = await evaluate(
    cdp,
    `(async () => {
      const startedAt = Date.now()
      let duration = 0
      while (Date.now() - startedAt < 30000) {
        const video = document.querySelector('video')
        if (video && video.duration > 1) { duration = video.duration; break }
        await new Promise((r) => setTimeout(r, 50))
      }
      // 一拿到时长就取样：此刻若是「从 0 播起」，读数只会在个位数
      const video = document.querySelector('video')
      const at = video ? Number(video.currentTime.toFixed(2)) : -1

      ${OPEN_DB}
      const rows = await new Promise((resolve, reject) => {
        const tx = db.transaction('skip', 'readonly')
        const req = tx.objectStore('skip').getAll()
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })

      return {
        reloaded: typeof window.__skipReloadMark === 'undefined',
        duration,
        at,
        elapsed: Date.now() - startedAt,
        keys: rows.map((row) => row.key),
        hash: decodeURIComponent(location.hash)
      }
    })()`
  )
  record(
    '重载应用后片头配置仍在（本地库读得回来）',
    afterReload.reloaded === true &&
      Array.isArray(afterReload.keys) &&
      afterReload.keys.includes(`local:${BASE}/seek-${RUN_ID}.mp4`),
    `真的重载过=${afterReload.reloaded} 库里的跳过配置=${JSON.stringify(afterReload.keys)}`
  )
  record(
    '重载后片头配置直接生效（拿到时长那一刻画面已在片头之后）',
    afterReload.reloaded === true && afterReload.duration > 1 && afterReload.at >= 8.5,
    `时长=${Number(afterReload.duration).toFixed(1)}s 取样点=${afterReload.at}s（${afterReload.elapsed}ms 后）` +
      ` — 从 0 播起的话这个读数只会在个位数`
  )

  /* ---------- H. 可视化证据：点击瞬间的截图 ---------- */
  const SHOT_DIR = `${ROOT}/.smoke/shots`
  mkdirSync(SHOT_DIR, { recursive: true })

  await evaluate(
    cdp,
    `location.hash = '#/play?path=' + encodeURIComponent(${JSON.stringify(`${BASE}/buffer.mp4`)}) + '&title=%E5%8A%A0%E8%BD%BD%E5%8F%8D%E9%A6%88'`
  )
  await delay(1500)
  await cdp.send('Page.enable')

  // 等到拿到时长、且确实已经有一小段缓冲（这样「滑块跑到了缓冲之外」才有说服力）
  await evaluate(
    cdp,
    `(async () => {
      const video = document.querySelector('video')
      const deadline = Date.now() + 25000
      while (Date.now() < deadline && !(video.duration > 1)) await new Promise((r) => setTimeout(r, 200))
      const until = Date.now() + 8000
      while (Date.now() < until && video.buffered.length === 0) await new Promise((r) => setTimeout(r, 200))
      return true
    })()`
  )

  // 点 70%，**立刻**截图：此刻滑块已经到位，而数据还在路上 —— 用户报的两个问题一眼可辨
  await evaluate(
    cdp,
    `(async () => {
      ${ENSURE_CONTROLS}
      const bar = document.querySelector('.player__progress')
      const rect = await ensureControls()
      const x = rect.left + rect.width * 0.7
      const y = rect.top + rect.height / 2
      const opts = { clientX: x, clientY: y, bubbles: true, pointerId: 1 }
      bar.dispatchEvent(new PointerEvent('pointermove', opts))
      bar.dispatchEvent(new PointerEvent('pointerdown', opts))
      bar.dispatchEvent(new PointerEvent('pointerup', opts))
      return true
    })()`
  )
  await delay(700)

  try {
    const data = await captureFrame(cdp)
    if (data) {
      writeFileSync(`${SHOT_DIR}/seek-loading.png`, Buffer.from(data, 'base64'))
      console.log(`\n  截图已保存：.smoke/shots/seek-loading.png（点击瞬间：滑块已到位 + 加载遮罩读数）`)
    }
  } catch (error) {
    console.log(`  截图失败（不影响用例结论）：${error?.message ?? error}`)
  }

  // 第二张：限速 HLS 直播流。原生 mp4 拿不到字节级吞吐（遮罩只有「已缓冲」），
  // 只有 hls.js 能报出真实速度 —— 这张图用来证明「网络速度」确实显示出来了。
  await evaluate(
    cdp,
    `location.hash = '#/play?path=' + encodeURIComponent(${JSON.stringify(`${BASE}/hls-slow/index.m3u8`)}) + '&title=%E7%9B%B4%E6%92%AD%E5%8A%A0%E8%BD%BD'`
  )
  const speedSeen = await evaluate(
    cdp,
    `(async () => {
      const deadline = Date.now() + 30000
      while (Date.now() < deadline) {
        const speed = document.querySelector('.player__loading-speed')?.textContent?.trim() ?? ''
        const label = document.querySelector('.player__loading-label')?.textContent?.trim() ?? ''
        const stats = document.querySelector('.player__loading-stats')?.textContent?.trim() ?? ''
        if (speed && label) {
          // 不暂停、不干预：遮罩与速度读数的重叠窗口会随缓冲周期反复出现，
          // 交给下面的「探测 → 连拍」循环去撞（暂停反而会让缓冲不再排空，周期停摆）
          return { ok: true, speed, label, stats }
        }
        await new Promise((r) => setTimeout(r, 100))
      }
      return {
        ok: false,
        label: document.querySelector('.player__loading-label')?.textContent?.trim() ?? '',
        stats: document.querySelector('.player__loading-stats')?.textContent?.trim() ?? '',
        hasVideo: !!document.querySelector('video'),
        err: document.querySelector('.player__error')?.textContent?.trim() ?? ''
      }
    })()`
  )
  record(
    'HLS 加载遮罩显示实时网络速度',
    speedSeen.ok === true,
    speedSeen.ok
      ? `速度=${speedSeen.speed} 文案="${speedSeen.label}" 读数="${speedSeen.stats}"`
      : `未捕获到速度读数（文案="${speedSeen.label}" 读数="${speedSeen.stats}" 播放器提示="${speedSeen.err}"）`
  )
  try {
    // 撞窗口。「探测到就立刻连拍」仍可能拍空（遮罩可能在下一帧就被清掉），
    // 所以给足 30 秒反复撞；screencast 取到的一定是当前帧，不必再赌抓帧延迟。
    console.log('  等待「遮罩 + 速度读数」同时在场以截图…')
    const shotDeadline = Date.now() + 30000
    while (Date.now() < shotDeadline) {
      const state = await evaluate(
        cdp,
        `(() => ({
          overlay: !!document.querySelector('.player__loading'),
          speed: document.querySelector('.player__loading-speed')?.textContent?.trim() ?? '',
          label: document.querySelector('.player__loading-label')?.textContent?.trim() ?? '',
          stats: document.querySelector('.player__loading-stats')?.textContent?.trim() ?? ''
        }))()`
      )
      if (state.overlay && state.speed) {
        const started = Date.now()
        const data = await captureFrame(cdp)
        const stillThere = await evaluate(cdp, `!!document.querySelector('.player__loading-speed')`)
        console.log(
          `  （抓帧耗时 ${Date.now() - started}ms，拍前读数「${state.stats}」，拍后速度仍在=${stillThere}）`
        )
        if (data) {
          writeFileSync(`${SHOT_DIR}/hls-speed.png`, Buffer.from(data, 'base64'))
          console.log(`  截图已保存：.smoke/shots/hls-speed.png（HLS 缓冲中的网络速度读数）`)
          break
        }
      }
      await delay(200)
    }
  } catch (error) {
    console.log(`  截图失败（不影响用例结论）：${error?.message ?? error}`)
  }

} catch (error) {
  record('测试执行', false, String(error?.message ?? error))
} finally {
  try {
    cdp?.close()
  } catch {
    /* ignore */
  }
  await closeBrowser()
  await killTree(electron)
  await new Promise((res) => server.close(res))
  await delay(800)

  const failed = results.filter((r) => !r.ok)
  console.log(`\n===== ${results.length - failed.length}/${results.length} 通过 =====`)
  if (failed.length && electronLog) {
    console.log('--- electron 日志尾部 ---')
    console.log(electronLog.split('\n').slice(-20).join('\n'))
  }
  process.exit(failed.length ? 1 : 0)
}
