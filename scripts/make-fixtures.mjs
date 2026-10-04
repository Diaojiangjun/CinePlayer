/**
 * 生成冒烟测试用的视频素材（放在 .smoke/ 下，已被 .gitignore 忽略）。
 * 覆盖四种典型情况：
 *   h264-aac.mp4  → 直接播放
 *   h264-ac3.mkv  → 视频可直用、音频需换 → 转封装
 *   hevc-aac.mkv  → HEVC 需转封装进 fMP4
 *   vp9-opus.mkv  → VP9/Opus 需转封装进 WebM
 *   xvid-mp3.avi  → 编码与容器都不支持 → 转码
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\\/g, '/').replace(/\/$/, '')
const OUT = `${ROOT}/.smoke`
const FFMPEG = `${ROOT}/node_modules/@ffmpeg-installer/win32-x64/ffmpeg.exe`

/**
 * 用**异步** spawn 跑 ffmpeg 并等它结束。
 * 部分受限环境（沙箱 / 作业对象）会拒绝同步创建进程，`spawnSync` 直接抛 EBUSY，
 * 素材就再也生成不出来 —— 而这里生成的正是「能不能播」的判据本身。
 */
function runFfmpeg(args) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(FFMPEG, args, { stdio: 'inherit', windowsHide: true })
    } catch {
      resolve(null)
      return
    }
    child.on('error', () => resolve(null))
    child.on('close', (code) => resolve(code))
  })
}

if (!existsSync(FFMPEG)) {
  console.error(`找不到 ffmpeg：${FFMPEG}\n请先执行 npm install`)
  process.exit(1)
}

mkdirSync(OUT, { recursive: true })

const SOURCE = [
  '-f',
  'lavfi',
  '-i',
  'testsrc=size=640x360:rate=25:duration=5',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=440:duration=5'
]

const JOBS = [
  {
    file: 'h264-aac.mp4',
    args: ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k']
  },
  {
    file: 'h264-ac3.mkv',
    args: ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'ac3', '-b:a', '192k']
  },
  {
    file: 'hevc-aac.mkv',
    args: [
      '-c:v',
      'libx265',
      '-preset',
      'ultrafast',
      '-x265-params',
      'log-level=error',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac'
    ]
  },
  {
    file: 'vp9-opus.mkv',
    args: ['-c:v', 'libvpx-vp9', '-b:v', '300k', '-c:a', 'libopus']
  },
  {
    file: 'xvid-mp3.avi',
    args: ['-c:v', 'mpeg4', '-q:v', '6', '-c:a', 'mp3']
  },
  {
    /**
     * 纯视频（无音轨）。
     *
     * 本机环境的音频渲染器时好时坏 —— 一旦起不来，整个 `<video>` 会以
     * `MEDIA_ERR_DECODE / AUDIO_RENDERER_ERROR` 收场，哪怕画面解码完全正常。
     * 需要**稳定画面**的用例（字幕渲染、播放反馈）都用这一份，
     * 把环境限制从断言路径里摘出去，否则用例会毫无规律地翻红。
     */
    file: 'noaudio.mp4',
    args: ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-an']
  },
  {
    /**
     * 纯视频 + **非原生封装**（MKV）→ 探测策略是 `remux`。
     *
     * 存在的理由：其余 remux / transcode 夹具都带音轨，而本机音频渲染器不可用，
     * 于是「转封装之后能不能自动播放」这条路径一直没法在无手势条件下验证
     * （带音轨的素材会先以 AUDIO_RENDERER_ERROR 收场，把自动播放的结论搅浑）。
     * 这一份没有音轨，可以干净地测「转封装 → 起播」。
     */
    file: 'noaudio-remux.mkv',
    args: ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-an']
  }
]

for (const job of JOBS) {
  const target = `${OUT}/${job.file}`
  if (existsSync(target)) {
    console.log(`跳过（已存在） ${job.file}`)
    continue
  }
  const status = await runFfmpeg([
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    ...SOURCE,
    ...job.args,
    target
  ])
  if (status !== 0) {
    console.error(`生成失败：${job.file}`)
    process.exit(status ?? 1)
  }
  console.log(`已生成 ${job.file}`)
}

console.log('素材就绪。')
