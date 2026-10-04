/**
 * 真实「分享页」播放地址复核（需要联网，手动运行，不进 smoke 链路）。
 *
 * 用法（具体站点地址不写进仓库，运行时传入）：
 *   node scripts/probe-real-stream.mjs <分享页地址> [更多地址…]
 *
 * 它验证的是**整条链路真的通**，而不是只看解析函数返回了个字符串：
 *   分享页地址 → 解析出 m3u8 → 拉播放列表 → 拉子播放列表 → 拉第一个分片
 *
 * ⚠️ 刻意不验证「画面有没有出来」：本机是无图形加速的虚拟化环境，
 * 音频渲染器起不来会让**任何带音轨**的媒体元素以 MEDIA_ERR_DECODE(3) 收场
 * （视频本身解码正常）。那是环境限制，不是播放链路的问题。
 * 在正常机器上这一段会正常播放。
 */
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { mkdirSync } from 'node:fs'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\\/g, '/').replace(/\/$/, '')
const PORT = 9345
const USER_DATA = `${ROOT}/.smoke/userdata-probe`

const targets = process.argv.slice(2).filter((arg) => /^https?:\/\//i.test(arg))
if (!targets.length) {
  console.error(
    '[probe-real-stream] 缺少分享页地址。\n' +
      '用法：node scripts/probe-real-stream.mjs <分享页地址> [更多地址…]'
  )
  process.exit(1)
}

mkdirSync(USER_DATA, { recursive: true })

function runCommand(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'ignore', windowsHide: true })
    child.on('error', () => resolve(false))
    child.on('close', () => resolve(true))
  })
}

async function killTree(child) {
  if (!child?.pid) return
  await runCommand('taskkill', ['/F', '/T', '/PID', String(child.pid)])
}

const cleanEnv = { ...process.env, NODE_OPTIONS: '' }
delete cleanEnv.ELECTRON_RUN_AS_NODE

let cdp = null
let electron = null

try {
  electron = spawn(
    `${ROOT}/node_modules/electron/dist/electron.exe`,
    [
      '.',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${USER_DATA}`,
      '--in-process-gpu',
      '--disable-gpu'
    ],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: cleanEnv }
  )

  let log = ''
  electron.stdout.on('data', (c) => (log += c.toString()))
  electron.stderr.on('data', (c) => (log += c.toString()))

  const deadline = Date.now() + 30000
  let target = null
  while (Date.now() < deadline && !target) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) ?? null
    } catch {
      /* 还没起来 */
    }
    if (!target) await delay(400)
  }
  if (!target) throw new Error(`等不到调试目标\n${log.slice(-2000)}`)

  cdp = await new Promise((resolve, reject) => {
    const socket = new WebSocket(target.webSocketDebuggerUrl)
    let nextId = 1
    const pending = new Map()
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
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
  await cdp.send('Runtime.enable')
  await delay(2000)

  const evaluate = async (expression, timeoutMs = 60000) => {
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

  let failures = 0
  const check = (name, ok, detail = '') => {
    if (!ok) failures++
    console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  }

  for (const url of targets) {
    console.log(`\n分享页：${url}`)

    // 1. 走真实的 IPC：分享页 → 可播地址
    const resolved = await evaluate(`window.api.stream.resolve(${JSON.stringify(url)})`)
    check(
      '解析出可播地址',
      resolved?.ok === true && resolved.from === 'page',
      JSON.stringify(resolved)
    )
    if (!resolved?.ok) continue

    // 2. 从渲染层把解析结果拉一遍 —— 主进程补的 CORS 头要真的生效
    const playlist = await evaluate(
      `(async () => {
        const response = await fetch(${JSON.stringify(resolved.url)})
        const text = await response.text()
        return {
          status: response.status,
          type: response.headers.get('content-type'),
          head: text.slice(0, 120),
          isMaster: /#EXT-X-STREAM-INF/i.test(text),
          firstChild: (text.split(/\\r?\\n/).find((line) => line && !line.startsWith('#')) ?? '').trim()
        }
      })()`
    )
    check('播放列表可拉取且是合法 m3u8', playlist.status === 200 && /#EXTM3U/.test(playlist.head), `status=${playlist.status} type=${playlist.type} head=${JSON.stringify(playlist.head.slice(0, 40))}`)

    // 3. 若是 master，就继续往下钻一层，确认子播放列表也拿得到
    if (playlist.isMaster && playlist.firstChild) {
      const child = await evaluate(
        `(async () => {
          const childUrl = new URL(${JSON.stringify(playlist.firstChild)}, ${JSON.stringify(resolved.url)}).href
          const response = await fetch(childUrl)
          const text = await response.text()
          return {
            url: childUrl,
            status: response.status,
            segments: (text.match(/^[^#\\s].*\\.(ts|m4s|mp4)/gm) ?? []).length,
            firstSegment: (text.split(/\\r?\\n/).find((line) => line && !line.startsWith('#')) ?? '').trim(),
            childUrl
          }
        })()`
      )
      check(
        '子播放列表可拉取并解析出分片',
        child.status === 200 && child.segments > 0,
        `status=${child.status} 分片数=${child.segments} 子列表=${child.url}`
      )

      // 4. 再取一个真实分片，证明确实能拿到媒体数据
      if (child.firstSegment) {
        const segment = await evaluate(
          `(async () => {
            const url = new URL(${JSON.stringify(child.firstSegment)}, ${JSON.stringify(child.url)}).href
            const response = await fetch(url)
            const buffer = await response.arrayBuffer()
            return { status: response.status, type: response.headers.get('content-type'), bytes: buffer.byteLength }
          })()`
        )
        check(
          '第一个分片可下载',
          segment.status === 200 && segment.bytes > 1000,
          `status=${segment.status} type=${segment.type} 大小=${segment.bytes} 字节`
        )
      }
    }
  }

  console.log(`\n${failures === 0 ? '全部通过' : `有 ${failures} 项失败`}\n`)
  if (failures > 0) process.exitCode = 1
} catch (error) {
  console.error('复核失败：', error?.message ?? error)
  process.exitCode = 1
} finally {
  try {
    cdp?.close()
  } catch {
    /* ignore */
  }
  await killTree(electron)
}
