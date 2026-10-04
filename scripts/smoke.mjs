/**
 * CinePlayer 端到端冒烟测试
 *
 * 用 CDP 驱动真实的 Electron 应用，验证：
 *  1. cine-file:// 协议 + HTTP Range（拖动进度条依赖）
 *  2. 本地文件在 <video> 中真实解码播放
 *  3. FFprobe 探测策略（direct / remux / transcode）
 *  4. FFmpeg 转封装、转码后的文件真的能播
 *  5. 拖拽落地 → 解析路径 → 写入媒体库 → 跳转播放页
 *
 * ⚠️ 数据安全：应用以 --user-data-dir 指向 .smoke/userdata 启动，
 * 使用独立的 IndexedDB，绝不会读写用户的真实媒体库 / 历史 / 收藏。
 *
 * 运行：npm run smoke（会先自动生成测试素材）
 */
import { spawn } from 'node:child_process'
import { Buffer } from 'node:buffer'
import { mkdirSync, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\\/g, '/').replace(/\/$/, '')

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

/**
 * Windows 上 child.kill() 只杀主进程，renderer / GPU 子进程会变成孤儿并持续空转，
 * 累积几十个进程后会拖垮整机。必须用 taskkill /T 连同进程树一起结束。
 */
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

/** 通过 CDP 的 Browser.close 让 Electron 自己退出，比强杀更干净 */
async function closeBrowser() {
  try {
    const version = await fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.json())
    const socket = new WebSocket(version.webSocketDebuggerUrl)
    await new Promise((resolve) => socket.addEventListener('open', resolve))
    socket.send(JSON.stringify({ id: 1, method: 'Browser.close' }))
    await delay(1500)
    socket.close()
  } catch {
    /* 拿不到就交给 killTree */
  }
}
const PORT = 9222
const MEDIA_DIR = `${ROOT}/.smoke`
const USER_DATA = `${MEDIA_DIR}/userdata`

/** 与主进程 base64url 编码保持一致 */
const mediaUrl = (filePath) => `cine-file://local/${Buffer.from(filePath, 'utf8').toString('base64url')}`

const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

async function waitForTarget(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await res.json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      /* 还没起来 */
    }
    await delay(400)
  }
  throw new Error('等待调试目标超时')
}

/** 事件回调只保留一个：截图需要用 screencast 的事件流 */
let onCdpEvent = null

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl)
    let nextId = 1
    const pending = new Map()

    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.method) {
        onCdpEvent?.(message)
        return
      }
      const entry = pending.get(message.id)
      if (!entry) return
      pending.delete(message.id)
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)))
      else entry.resolve(message.result)
    })
    socket.addEventListener('error', reject)
    socket.addEventListener('open', () => {
      resolve({
        send(method, params = {}) {
          const id = nextId++
          socket.send(JSON.stringify({ id, method, params }))
          return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej }))
        },
        close: () => socket.close()
      })
    })
  })
}

/**
 * 取一张**当前**画面的截图，返回 base64。
 *
 * 不能直接用 `Page.captureScreenshot`：本机是无 GPU 的虚拟桌面，合成器经常
 * 交回一帧很旧的画面（甚至干脆不返回，把 evaluate 挂到超时）——
 * 那样截图会「证明」一件早就不是事实的事，比没有截图更糟。
 * 改用 screencast：它主动推一帧过来，拿到的必定是当下的画面，并且有超时兜底。
 */
function captureFrame(cdp, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      onCdpEvent = null
      reject(new Error('截图超时（screencast 没有推帧）'))
    }, timeoutMs)

    onCdpEvent = async (message) => {
      if (message.method !== 'Page.screencastFrame') return
      clearTimeout(timer)
      onCdpEvent = null
      try {
        await cdp.send('Page.screencastFrameAck', { sessionId: message.params.sessionId })
        await cdp.send('Page.stopScreencast')
      } catch {
        /* 收尾失败不影响拿到的帧 */
      }
      resolve(message.params.data)
    }

    cdp
      .send('Page.startScreencast', { format: 'png', everyNthFrame: 1 })
      .catch((error) => {
        clearTimeout(timer)
        onCdpEvent = null
        reject(error)
      })
  })
}

async function evaluate(cdp, expression, timeoutMs = 90000) {
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
    const text = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
    throw new Error(text)
  }
  return result.result.value
}

/**
 * 与 `evaluate` 的唯一区别：**不授予用户手势**。
 *
 * CDP 的 `userGesture: true` 会给文档「粘性激活」，授予之后撤不回来 ——
 * 之后页面里再 `video.play()` 必然成功。所以「能不能自动播放」的用例
 * 必须跑在任何 `userGesture: true` 之前，并且只用这个函数。
 */
async function evaluateNoGesture(cdp, expression, timeoutMs = 90000) {
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
    const text = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
    throw new Error(text)
  }
  return result.result.value
}

mkdirSync(USER_DATA, { recursive: true })

/**
 * 外挂字幕夹具必须在应用启动**之前**落盘。
 * 播放器只在「元数据就绪」那一刻扫一次视频同目录 —— 那之后再补文件是扫不到的，
 * 用例就会变成一个永远测不出东西的假绿。
 */
writeFileSync(
  `${MEDIA_DIR}/noaudio.srt`,
  [
    '1',
    '00:00:00,200 --> 00:00:02,500',
    '第一条外挂字幕',
    '',
    '2',
    '00:00:02,600 --> 00:00:04,500',
    '第二条外挂字幕',
    '',
    '3',
    '00:00:04,600 --> 00:00:05,000',
    '第三条外挂字幕',
    ''
  ].join('\n')
)

const cleanEnv = { ...process.env, NODE_OPTIONS: '' }
delete cleanEnv.ELECTRON_RUN_AS_NODE
delete cleanEnv.ELECTRON_NO_ATTACH_CONSOLE

const electron = spawn(
  `${ROOT}/node_modules/electron/dist/electron.exe`,
  [
    '.',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${USER_DATA}`,
    '--in-process-gpu',
    '--disable-gpu'
  ],
  {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: cleanEnv
  }
)

let electronLog = ''
electron.stdout.on('data', (chunk) => (electronLog += chunk.toString()))
electron.stderr.on('data', (chunk) => (electronLog += chunk.toString()))

let cdp
try {
  const target = await waitForTarget()
  cdp = await connect(target.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')
  await delay(1500)

  /* ---------- 0a. 自动播放（必须排在任何 userGesture:true 之前） ---------- */
  /**
   * 用户反馈「视频无法自动播放，每次都要手动点击」，而原来的用例一条都测不出来 ——
   * 因为脚本用的 `evaluate` 带 `userGesture: true`，早就把文档「激活」过了，
   * 自动播放必然成功。这一节改用不带手势的版本，分**三种起播路径**覆盖：
   *   ① 直链本地文件（cine-file://）
   *   ② 需要**转封装**的 MKV（探测 → FFmpeg → 换新地址再起播，异步最长）
   *   ③ 原生支持但同目录有外挂字幕的 mp4（起播处理器里还要刷新字幕轨）
   * 任何一种不自动播，都会在这里暴露。
   */
  const activationProbe = await evaluateNoGesture(
    cdp,
    `({
      hasBeenActive: navigator.userActivation?.hasBeenActive ?? null,
      supported: typeof navigator.userActivation !== 'undefined'
    })`
  )
  record(
    '自动播放用例的前提：文档此刻从未有过用户手势',
    activationProbe.supported === true && activationProbe.hasBeenActive === false,
    JSON.stringify(activationProbe)
  )

  /** 全程不调用 video.play()：currentTime 能推进就只可能是页面自己播起来的 */
  const autoplayProbe = (timeoutMs) => `(async () => {
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
          preparing: !!document.querySelector('.player__prepare'),
          fallbackVisible: !!document.querySelector('.player__autoplay'),
          fatal: (document.querySelector('.player__error')?.textContent || '').trim(),
          hasBeenActive: navigator.userActivation?.hasBeenActive ?? null,
          error: video.error ? video.error.code : null
        }
        if (!video.paused && video.currentTime > 0.3 && video.videoWidth > 0) {
          return { ok: true, ...last }
        }
      }
      await new Promise((r) => setTimeout(r, 200))
    }
    return { ok: false, ...last }
  })()`

  async function assertAutoplay(label, path, timeoutMs = 25000) {
    await evaluateNoGesture(
      cdp,
      `location.hash = '#/play?path=' + encodeURIComponent(${JSON.stringify(path)})` +
        ` + '&title=' + encodeURIComponent(${JSON.stringify(label)})`
    )
    const probe = await evaluateNoGesture(cdp, autoplayProbe(timeoutMs), timeoutMs + 15000)
    record(
      label,
      probe.ok === true && probe.hasBeenActive === false,
      probe.ok
        ? `已播至=${probe.currentTime.toFixed(2)}s 分辨率=${probe.width}` +
          ` 文档已被激活=${probe.hasBeenActive}（须为 false，否则用例无意义）`
        : `暂停=${probe.paused} currentTime=${probe.currentTime?.toFixed?.(2) ?? probe.currentTime}` +
          ` readyState=${probe.readyState} duration=${probe.duration} 宽度=${probe.width}` +
          ` 文档已被激活=${probe.hasBeenActive} err=${probe.error} 转码中=${probe.preparing}` +
          ` 报错="${probe.fatal}" 补救入口可见=${probe.fallbackVisible}`
    )
    return probe
  }

  await assertAutoplay('本地直链文件进页面即自动播放（无需点击）', `${MEDIA_DIR}/noaudio.mp4`)
  await assertAutoplay('需转封装的 MKV：转完后自动播放（无需点击）', `${MEDIA_DIR}/noaudio-remux.mkv`, 45000)
  // 用户说的是「每次都要手动点击」——所以要证明第 N 次打开同样会自动起播，
  // 而不是「只有冷启动那一次碰巧能播」
  await assertAutoplay('换个视频再打开，依然自动播放（不是只有第一次能播）', `${MEDIA_DIR}/noaudio.mp4`)

  /*
   * ⚠️ 上面几条把应用停在了**播放页**，而后续用例依赖主界面
   * （主题按钮在侧边栏 `.sidebar__footer` 里）。必须显式回主界面，
   * 否则后面的用例会因为「找不到侧边栏按钮」而失败 ——
   * 现象看着像「主题功能坏了」，实际是上一条用例留下的页面状态。
   */
  await evaluateNoGesture(cdp, `location.hash = '#/library'`)
  await delay(800)

  const appReady = await evaluate(cdp, `document.querySelector('#app') !== null && !!window.api`)
  record('应用启动 & preload 桥可用', appReady === true, appReady ? '' : 'window.api 未注入')

  /* ---------- 0b. 主题切换（含持久化） ---------- */
  /**
   * 这条用例盯的是一个真实缺陷：`ref()` 会把设置对象深度包成 Proxy，
   * 而 IndexedDB 的结构化克隆克隆不了 Proxy —— 写库抛 DataCloneError，
   * 排在 `await` 之后的 `applyTheme()` 就永远执行不到，表现是「点了按钮界面毫无反应」。
   * 所以这里必须同时断言「界面变了」和「真的落库了」，只断言前者会漏掉一半。
   */
  const THEME_PROBE = `(() => ({
    attr: document.documentElement.getAttribute('data-theme'),
    bg: getComputedStyle(document.body).backgroundColor,
    label: document.querySelector('.sidebar__footer button')?.textContent?.trim() ?? ''
  }))()`

  const readPersistedTheme = `(async () => {
    return await new Promise((resolve) => {
      const open = indexedDB.open('cineplayer')
      open.onerror = () => resolve(null)
      open.onsuccess = () => {
        const db = open.result
        try {
          const get = db.transaction('settings', 'readonly').objectStore('settings').get(1)
          get.onsuccess = () => resolve(get.result?.theme ?? null)
          get.onerror = () => resolve(null)
        } catch (error) {
          resolve(null)
        }
      }
    })
  })()`

  const themeBefore = await (async () => {
    // 必须等设置真的从库里读出来并应用：`load()` 是异步的，
    // 固定 sleep 在高负载下会读到还没应用主题的状态，而且此时去点按钮，
    // 会被随后完成的 `load()` 覆盖回去 —— 那是测试的时序问题，不是产品缺陷。
    // `data-theme` 由 `applyTheme()` 同步写上，它出现即代表启动流程走完了。
    let probe = null
    for (let attempt = 0; attempt < 60; attempt++) {
      probe = await evaluate(cdp, THEME_PROBE)
      if (probe.attr) return probe
      await delay(200)
    }
    return probe
  })()
  record(
    '默认主题为深色',
    themeBefore.attr === 'dark' && themeBefore.label === '切换浅色',
    JSON.stringify(themeBefore)
  )

  await evaluate(
    cdp,
    `document.querySelector('.sidebar__footer button').click(), true`
  )
  await delay(700)
  const themeAfter = await evaluate(cdp, THEME_PROBE)
  record(
    '点一下主题按钮，界面立刻切成浅色',
    themeAfter.attr === 'light' &&
      themeAfter.bg !== themeBefore.bg &&
      themeAfter.label === '切换深色',
    JSON.stringify(themeAfter)
  )

  const persistedTheme = await evaluate(cdp, readPersistedTheme)
  record(
    '主题真的写进了数据库（DataCloneError 回归守卫）',
    persistedTheme === 'light',
    `库中 theme=${JSON.stringify(persistedTheme)}`
  )

  // 留一张浅色主题的截图：这类「界面没变化」的反馈，图比断言好读
  try {
    const shotDir = `${MEDIA_DIR}/shots`
    mkdirSync(shotDir, { recursive: true })
    const data = await captureFrame(cdp)
    if (data) {
      writeFileSync(`${shotDir}/theme-light.png`, Buffer.from(data, 'base64'))
      console.log('  截图已保存：.smoke/shots/theme-light.png（切到浅色主题后的界面）')
    }
  } catch (error) {
    console.log(`  截图失败（不影响用例结论）：${error?.message ?? error}`)
  }

  // 重启视图：重新加载页面后，主题应当从库里读回来
  await cdp.send('Page.reload', { ignoreCache: true })
  let themeAfterReload = null
  for (let attempt = 0; attempt < 40; attempt++) {
    await delay(400)
    try {
      const probe = await evaluate(cdp, THEME_PROBE)
      if (probe.attr) {
        themeAfterReload = probe
        break
      }
    } catch {
      /* 页面还在重建，继续等 */
    }
  }
  record(
    '重新加载后仍是浅色（设置真的持久化了）',
    themeAfterReload?.attr === 'light' && themeAfterReload?.label === '切换深色',
    JSON.stringify(themeAfterReload)
  )

  // 切回深色，把状态还原，顺便证明它不是单向的
  await evaluate(cdp, `document.querySelector('.sidebar__footer button').click(), true`)
  await delay(700)
  const themeBack = await evaluate(cdp, THEME_PROBE)
  record(
    '再点一下切回深色',
    themeBack.attr === 'dark' && themeBack.label === '切换浅色',
    JSON.stringify(themeBack)
  )

  const caps = await evaluate(cdp, 'window.api.media.capabilities()')
  record(
    'FFmpeg / FFprobe 能力探测',
    caps.ffmpeg === true && caps.ffprobe === true,
    JSON.stringify(caps)
  )

  /* ---------- 1. 协议 + Range ---------- */
  const mp4 = `${MEDIA_DIR}/h264-aac.mp4`
  const url = mediaUrl(mp4)
  const rangeCheck = await evaluate(
    cdp,
    `(async () => {
      const url = ${JSON.stringify(url)}
      const full = await fetch(url)
      const head = await fetch(url, { headers: { Range: 'bytes=0-99' } })
      return {
        status: full.status,
        length: full.headers.get('content-length'),
        acceptRanges: full.headers.get('accept-ranges'),
        mime: full.headers.get('content-type'),
        partialStatus: head.status,
        partialRange: head.headers.get('content-range'),
        partialBytes: (await head.arrayBuffer()).byteLength
      }
    })()`
  )
  record(
    'cine-file:// 协议可读取本地文件',
    rangeCheck.status === 200 && rangeCheck.mime === 'video/mp4',
    `status=${rangeCheck.status} mime=${rangeCheck.mime} length=${rangeCheck.length}`
  )
  record(
    'HTTP Range 分段请求（206 + Content-Range）',
    rangeCheck.partialStatus === 206 &&
      rangeCheck.partialBytes === 100 &&
      /^bytes 0-99\//.test(rangeCheck.partialRange ?? ''),
    `status=${rangeCheck.partialStatus} range=${rangeCheck.partialRange} bytes=${rangeCheck.partialBytes}`
  )

  const badUrl = await evaluate(
    cdp,
    `fetch(${JSON.stringify(mediaUrl(`${MEDIA_DIR}/nope.mp4`))}).then(r => r.status)`
  )
  record('不存在的文件返回 404', badUrl === 404, `status=${badUrl}`)

  /* ---------- 2. 真实解码播放 ---------- */
  const playback = await evaluate(
    cdp,
    `(async () => {
      const url = ${JSON.stringify(url)}
      const video = document.createElement('video')
      video.muted = true
      video.style.cssText = 'position:fixed;left:0;top:0;width:160px;z-index:9999'
      document.body.appendChild(video)
      video.src = url

      const meta = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('metadata 超时')), 15000)
        video.onloadedmetadata = () => { clearTimeout(timer); resolve({ duration: video.duration, w: video.videoWidth, h: video.videoHeight }) }
        video.onerror = () => { clearTimeout(timer); reject(new Error('media error code=' + (video.error && video.error.code))) }
      })

      await video.play()
      // 冷启动时解码线程可能被抢占，轮询等待播放进度真正推进，避免固定 sleep 造成抖动。
      // 阈值只用于证明「确实在解码推进」，不追求速率，因此取一个很小的值。
      const advanced = await new Promise((resolve, reject) => {
        const deadline = Date.now() + 20000
        const tick = () => {
          if (video.currentTime > 0.3) return resolve(video.currentTime)
          if (Date.now() > deadline) return reject(new Error('播放进度未推进，currentTime=' + video.currentTime))
          setTimeout(tick, 200)
        }
        tick()
      })
      const paused = video.paused

      // 拖动进度条：跳到 3s
      video.currentTime = 3
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('seek 超时')), 8000)
        video.onseeked = () => { clearTimeout(timer); resolve() }
      })

      const seeked = video.currentTime
      video.remove()
      return { duration: meta.duration, width: meta.w, height: meta.h, advanced, paused, seeked }
    })()`
  )
  record(
    'MP4（H.264/AAC）解码播放',
    playback.duration > 4 && playback.advanced > 0.15 && playback.paused === false,
    `duration=${playback.duration?.toFixed(2)} width=${playback.width} 已播至=${playback.advanced?.toFixed(2)}s`
  )
  record('MP4 精确 seek', Math.abs(playback.seeked - 3) < 0.6, `seek 后 currentTime=${playback.seeked?.toFixed(2)}`)

  /* ---------- 3. 探测策略 ---------- */
  const probes = {}
  for (const file of ['h264-aac.mp4', 'h264-ac3.mkv', 'hevc-aac.mkv', 'vp9-opus.mkv', 'xvid-mp3.avi']) {
    probes[file] = await evaluate(cdp, `window.api.media.probe(${JSON.stringify(`${MEDIA_DIR}/${file}`)})`)
  }
  const expect = {
    'h264-aac.mp4': 'direct',
    'h264-ac3.mkv': 'remux',
    'hevc-aac.mkv': 'remux',
    'vp9-opus.mkv': 'remux',
    'xvid-mp3.avi': 'transcode'
  }
  for (const [file, strategy] of Object.entries(expect)) {
    const probe = probes[file]
    record(
      `探测策略 ${file} → ${strategy}`,
      probe.strategy === strategy,
      `实际=${probe.strategy} codec=${probe.videoCodec}/${probe.audioCodec}`
    )
  }

  /* ---------- 4. 转封装 / 转码后真的能播 ---------- */
  for (const file of ['h264-ac3.mkv', 'vp9-opus.mkv', 'xvid-mp3.avi']) {
    const prepared = await evaluate(cdp, `window.api.media.prepare(${JSON.stringify(`${MEDIA_DIR}/${file}`)})`)
    if (!prepared.ok) {
      record(`转换 ${file}`, false, prepared.message)
      continue
    }

    const played = await evaluate(
      cdp,
      `(async () => {
        const video = document.createElement('video')
        video.muted = true
        document.body.appendChild(video)
        video.src = ${JSON.stringify(mediaUrl(prepared.path))}
        try {
          const info = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('metadata 超时')), 15000)
            video.onloadedmetadata = () => { clearTimeout(timer); resolve({ duration: video.duration }) }
            video.onerror = () => { clearTimeout(timer); reject(new Error('media error code=' + (video.error && video.error.code))) }
          })
          await video.play()
          const advanced = await new Promise((resolve, reject) => {
            const deadline = Date.now() + 30000
            const tick = () => {
              if (video.currentTime > 0.1) return resolve(video.currentTime)
              if (Date.now() > deadline) {
                // 带上媒体内核的状态：本机环境曾出现过「音频渲染器起不来 →
                // 整个 <video> 报 MEDIA_ERR_DECODE」，只有这些字段能一眼分辨出来
                const err = video.error
                return reject(
                  new Error(
                    '播放进度未推进 readyState=' + video.readyState +
                    ' networkState=' + video.networkState +
                    ' paused=' + video.paused +
                    ' err=' + (err ? err.code + '(' + err.message + ')' : 'none')
                  )
                )
              }
              setTimeout(tick, 200)
            }
            tick()
          })
          return { ok: true, duration: info.duration, advanced }
        } catch (e) {
          return { ok: false, message: String(e.message || e) }
        } finally {
          video.remove()
        }
      })()`
    )
    record(
      `转换后可播放 ${file}（${prepared.strategy}${prepared.cached ? '/缓存' : ''}）`,
      played.ok === true && played.advanced > 0.05,
      played.ok ? `duration=${played.duration?.toFixed(2)} 已播至=${played.advanced?.toFixed(2)}s` : played.message
    )
  }

  /* ---------- 5. 拖拽导入链路 ---------- */
  const fileUri =
    'file:///' +
    mp4
      .replace(/\\/g, '/')
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/')

  const dropResult = await evaluate(
    cdp,
    `(async () => {
      const dt = new DataTransfer()
      dt.setData('text/uri-list', ${JSON.stringify(fileUri)})
      const event = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })
      window.dispatchEvent(event)

      // 轮询等跳转，而不是固定 sleep：机器负载高时 1.5s 可能还不够解析路径 + 写库
      const deadline = Date.now() + 20000
      while (Date.now() < deadline && !location.hash.startsWith('#/play')) {
        await new Promise((r) => setTimeout(r, 200))
      }

      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('cineplayer')
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      const rows = await new Promise((resolve, reject) => {
        const tx = db.transaction('media', 'readonly')
        const req = tx.objectStore('media').getAll()
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
      return { count: rows.length, paths: rows.map((r) => r.path), hash: location.hash }
    })()`
  )
  record(
    '拖拽落地 → 解析路径 → 写入媒体库',
    dropResult.paths.includes(mp4),
    `count=${dropResult.count} path=${dropResult.paths[0]}`
  )
  record(
    '拖入单个视频后自动进入播放页',
    String(dropResult.hash).startsWith('#/play'),
    `hash=${dropResult.hash}`
  )

  /* ---------- 6. 外挂字幕（同目录同名自动挂载 + 字幕菜单） ---------- */
  /**
   * 这条链路有好几个环节都可能断：主进程扫目录 → 读文件 → 解析格式 → 建 TextTrack。
   * 只断言「菜单里有这一项」是不够的，必须断言 **cues 真的进了 textTracks 且 mode=showing**，
   * 否则解析器写错了也照样绿。
   */
  const subtitleVideo = `${MEDIA_DIR}/noaudio.mp4`
  const srtPath = `${MEDIA_DIR}/noaudio.srt`

  const sidecar = await evaluate(
    cdp,
    `window.api.fs.subtitles(${JSON.stringify(subtitleVideo)})`
  )
  // 主进程用 path.join 拼路径，Windows 上给的是反斜杠；夹具路径是正斜杠，
  // 比较前统一一下 —— 这是断言侧的写法问题，不是路径本身不对。
  const samePath = (a, b) => String(a).replace(/\\/g, '/') === String(b).replace(/\\/g, '/')
  record(
    '主进程能扫到同目录同名外挂字幕',
    Array.isArray(sidecar) &&
      sidecar.some((item) => samePath(item.path, srtPath) && item.exact === true),
    `候选=${JSON.stringify(sidecar || [])}`
  )

  await evaluate(
    cdp,
    `location.hash = '#/play?path=' + encodeURIComponent(${JSON.stringify(subtitleVideo)}) + '&title=' + encodeURIComponent('字幕测试')`
  )

  const SUBTITLE_PROBE = `(() => {
    const video = document.querySelector('video')
    const tracks = []
    if (video) {
      for (let i = 0; i < video.textTracks.length; i++) {
        const track = video.textTracks[i]
        tracks.push({ label: track.label, mode: track.mode, cues: track.cues ? track.cues.length : 0 })
      }
    }
    return {
      ready: !!video && video.readyState >= 1,
      duration: video ? video.duration : 0,
      tracks,
      notice: document.querySelector('.player__notice')?.textContent?.trim() ?? '',
      hasSubtitleButton: !!document.querySelector('.player__bar button[title="字幕"]'),
      hasEpisodesButton: !!document.querySelector('.player__bar button[title="选集"]'),
      badge: !!document.querySelector('.player__badge-dot')
    }
  })()`

  let subtitleState = null
  for (let attempt = 0; attempt < 60; attempt++) {
    subtitleState = await evaluate(cdp, SUBTITLE_PROBE)
    const loaded = subtitleState.tracks?.some((t) => t.label === 'noaudio.srt' && t.mode === 'showing')
    if (subtitleState.ready && loaded) break
    await delay(250)
  }

  record(
    '播放页出现「字幕」入口',
    subtitleState?.hasSubtitleButton === true,
    `button=${subtitleState?.hasSubtitleButton}`
  )
  record(
    '同名字幕自动挂载并开始显示（cues 真的进了 textTracks）',
    subtitleState?.tracks?.some(
      (track) => track.label === 'noaudio.srt' && track.mode === 'showing' && track.cues === 3
    ) === true,
    `tracks=${JSON.stringify(subtitleState?.tracks)} 提示=${subtitleState?.notice}`
  )
  record(
    '字幕生效时按钮上有状态点',
    subtitleState?.badge === true,
    `badge=${subtitleState?.badge}`
  )
  record(
    '没有播放列表时不显示「选集」（不给空面板留入口）',
    subtitleState?.hasEpisodesButton === false,
    `episodesButton=${subtitleState?.hasEpisodesButton}`
  )

  // 打开字幕菜单 —— 三条路径（关闭 / 已挂的同目录字幕 / 手动选文件）都要在
  const subtitleMenu = await evaluate(
    cdp,
    `(async () => {
      const button = document.querySelector('.player__bar button[title="字幕"]')
      button?.click()
      // 用 setTimeout 而不是 requestAnimationFrame：窗口不可见 / 被遮挡时
      // 合成器会停发帧，rAF 可能一直不回调，evaluate 就会挂到超时。
      await new Promise((r) => setTimeout(r, 120))
      const menu = document.querySelector('.player__menu--wide')
      const items = menu ? Array.from(menu.querySelectorAll('.player__menu-item')).map((el) => el.textContent.trim()) : []
      return { open: !!menu, items }
    })()`
  )
  record(
    '字幕菜单列出：关闭 / 已加载字幕 / 从文件选择',
    subtitleMenu.open === true &&
      subtitleMenu.items.some((text) => text === '关闭') &&
      subtitleMenu.items.some((text) => text.includes('noaudio.srt')) &&
      subtitleMenu.items.some((text) => text.includes('从文件选择')),
    `items=${JSON.stringify(subtitleMenu.items)}`
  )

  const subtitleOff = await evaluate(
    cdp,
    `(async () => {
      const menu = document.querySelector('.player__menu--wide')
      if (!menu) return { modes: [], badge: false, missing: true }
      const off = Array.from(menu.querySelectorAll('.player__menu-item')).find((el) => el.textContent.trim() === '关闭')
      off?.click()
      await new Promise((r) => setTimeout(r, 300))
      const video = document.querySelector('video')
      const modes = []
      for (let i = 0; i < video.textTracks.length; i++) modes.push(video.textTracks[i].mode)
      return { modes, badge: !!document.querySelector('.player__badge-dot') }
    })()`
  )
  record(
    '选「关闭」后字幕真的停显（track 全部 disabled、状态点消失）',
    subtitleOff.modes.length > 0 &&
      subtitleOff.modes.every((mode) => mode === 'disabled') &&
      subtitleOff.badge === false,
    `modes=${JSON.stringify(subtitleOff.modes)} badge=${subtitleOff.badge} 菜单丢失=${!!subtitleOff.missing}`
  )

  // 留一张「字幕真的画在画面上」的截图：把播放头挪到有字幕的时间点再抓帧
  try {
    const shotDir = `${MEDIA_DIR}/shots`
    mkdirSync(shotDir, { recursive: true })
    const diag = await evaluate(
      cdp,
      `(() => {
        const video = document.querySelector('video')
        return {
          hash: decodeURIComponent(location.hash),
          preparing: !!document.querySelector('.player__prepare'),
          prepareLabel: document.querySelector('.player__prepare-label')?.textContent?.trim() ?? '',
          preparePercent: document.querySelector('.player__prepare-percent')?.textContent?.trim() ?? '',
          error: document.querySelector('.player__error')?.textContent?.trim() ?? '',
          src: video ? (video.currentSrc || video.src).slice(0, 90) : '(no video)',
          readyState: video?.readyState,
          duration: video?.duration,
          time: video?.currentTime,
          mediaError: video?.error ? video.error.code + ':' + video.error.message : '',
          trackModes: video ? Array.from({ length: video.textTracks.length }, (_, i) => video.textTracks[i].mode) : []
        }
      })()`,
      15000
    )
    console.log('  [诊断] ' + JSON.stringify(diag))

    const reopened = await evaluate(
      cdp,
      `(async () => {
        const button = document.querySelector('.player__bar button[title="字幕"]')
        button?.click()
        await new Promise((r) => setTimeout(r, 120))
        const item = Array.from(document.querySelectorAll('.player__menu--wide .player__menu-item'))
          .find((el) => el.textContent.trim() === 'noaudio.srt')
        item?.click()
        await new Promise((r) => setTimeout(r, 300))

        // 先把「正在分析 / 转码」这类阶段遮罩等掉，再抓帧 ——
        // 否则拍到的可能是上一阶段的界面，图就没法当证据用了。
        const deadline = Date.now() + 15000
        while (Date.now() < deadline && document.querySelector('.player__prepare')) {
          await new Promise((r) => setTimeout(r, 150))
        }
        const preparing = !!document.querySelector('.player__prepare')

        const video = document.querySelector('video')
        video.currentTime = 1
        // 注意：play() 在「还没有可加载的源」时不会 settle（规范如此），
        // 所以这里不能 await 它 —— 否则整段探针会一直挂着。
        void video.play().catch(() => undefined)
        // 等到播放头真的落在有字幕的时间段里，再截图
        const cueDeadline = Date.now() + 5000
        while (Date.now() < cueDeadline && video.currentTime < 0.3) {
          await new Promise((r) => setTimeout(r, 100))
        }
        await new Promise((r) => setTimeout(r, 400))
        return {
          preparing,
          time: video.currentTime,
          duration: video.duration,
          mode: video.textTracks[0]?.mode ?? '',
          cues: video.textTracks[0]?.cues?.length ?? 0
        }
      })()`
    )
    const data = await captureFrame(cdp)
    if (data) {
      writeFileSync(`${shotDir}/subtitle.png`, Buffer.from(data, 'base64'))
      console.log(
        `  截图已保存：.smoke/shots/subtitle.png（t=${reopened.time?.toFixed(1)}s / ${reopened.duration?.toFixed(1)}s，` +
          `track=${reopened.mode}，cues=${reopened.cues}，遮罩残留=${reopened.preparing}）`
      )
    }
  } catch (error) {
    console.log(`  截图失败（不影响用例结论）：${error?.message ?? error}`)
  }

  await evaluate(cdp, `document.querySelector('video')?.pause(), true`).catch(() => undefined)

  /* ---------- 7. 清理（只清本次测试写入的条目） ---------- */
  await evaluate(
    cdp,
    `(async () => {
      const path = ${JSON.stringify(mp4)}
      const db = await new Promise((r) => { const q = indexedDB.open('cineplayer'); q.onsuccess = () => r(q.result) })
      const rows = await new Promise((r) => { const tx = db.transaction('media', 'readonly'); const q = tx.objectStore('media').getAll(); q.onsuccess = () => r(q.result) })
      const ids = rows.filter((row) => row.path === path).map((row) => row.id)
      await new Promise((r) => { const tx = db.transaction('media', 'readwrite'); const store = tx.objectStore('media'); ids.forEach((id) => store.delete(id)); tx.oncomplete = r })
      return ids.length
    })()`
  ).catch(() => undefined)
  await evaluate(cdp, 'window.api.media.clearCache()').catch(() => undefined)
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
  await delay(800)

  const failed = results.filter((r) => !r.ok)
  console.log(`\n===== ${results.length - failed.length}/${results.length} 通过 =====`)
  if (failed.length && electronLog) {
    console.log('--- electron 日志尾部 ---')
    console.log(electronLog.split('\n').slice(-25).join('\n'))
  }
  process.exit(failed.length ? 1 : 0)
}
