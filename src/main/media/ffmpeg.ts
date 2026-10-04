import { app } from 'electron'
import { createHash } from 'crypto'
import { spawn, type ChildProcess } from 'child_process'
import { promises as fs } from 'fs'
import { join } from 'path'
import {
  extOfPath,
  isNativeContainer,
  titleOfPath,
  type MediaProbe,
  type MediaStrategy,
  type PrepareProgress,
  type PrepareResult
} from '../../shared/media'
import { resolveBinary } from './binaries'

/** Chromium 内核能直接解码的编码 */
const CHROMIUM_VIDEO = new Set(['h264', 'av1', 'vp8', 'vp9'])
const CHROMIUM_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis'])

/** 可以「视频流直接复制」进 MP4 / WebM 的编码（注意 mpeg4/Xvid 不在内，Chromium 解不了） */
const MP4_VIDEO = new Set(['h264', 'hevc'])
const WEBM_VIDEO = new Set(['vp8', 'vp9', 'av1'])

const CACHE_LIMIT_BYTES = 16 * 1024 * 1024 * 1024
const PROGRESS_THROTTLE_MS = 400
const PROBE_CACHE_LIMIT = 400

const probeCache = new Map<string, MediaProbe>()

/** 正在运行的转换任务：key -> 取消函数 */
const cancelHandles = new Map<string, () => void>()
/** 同一个文件重复请求时复用同一个 Promise */
const inFlight = new Map<string, Promise<PrepareResult>>()

/* ------------------------------------------------------------------ *
 * 缓存目录
 * ------------------------------------------------------------------ */

function cacheDir(): string {
  return join(app.getPath('userData'), 'media-cache')
}

async function ensureCacheDir(): Promise<string> {
  const dir = cacheDir()
  await fs.mkdir(dir, { recursive: true })
  return dir
}

function cacheKey(filePath: string, size: number, mtime: number, stamp: string): string {
  return createHash('sha1')
    .update(`${filePath}|${size}|${mtime}|${stamp}`)
    .digest('hex')
    .slice(0, 24)
}

function safeName(filePath: string): string {
  const base = titleOfPath(filePath).slice(0, 32)
  const cleaned = base.replace(/[^\w\u4e00-\u9fa5-]+/g, '_')
  return cleaned || 'video'
}

/** 超出上限时按最后访问时间清理旧缓存（后台执行，不阻塞播放） */
async function pruneCache(): Promise<void> {
  const dir = cacheDir()
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return
  }

  const files: { path: string; size: number; atime: number }[] = []
  for (const name of entries) {
    const full = join(dir, name)
    try {
      const stat = await fs.stat(full)
      if (stat.isFile()) files.push({ path: full, size: stat.size, atime: stat.atimeMs })
    } catch {
      /* 忽略单个文件 */
    }
  }

  let total = files.reduce((sum, file) => sum + file.size, 0)
  if (total <= CACHE_LIMIT_BYTES) return

  files.sort((a, b) => a.atime - b.atime)
  for (const file of files) {
    if (total <= CACHE_LIMIT_BYTES) break
    try {
      await fs.unlink(file.path)
      total -= file.size
    } catch {
      /* 忽略 */
    }
  }
}

/* ------------------------------------------------------------------ *
 * ffprobe 探测
 * ------------------------------------------------------------------ */

interface FfprobeStream {
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
}

interface FfprobeFormat {
  format_name?: string
  duration?: string
}

function runFfprobe(
  bin: string,
  filePath: string
): Promise<{ streams: FfprobeStream[]; format: FfprobeFormat }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      bin,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
      { windowsHide: true }
    )

    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `ffprobe 退出码 ${code}`))
        return
      }
      try {
        const parsed = JSON.parse(stdout) as { streams?: FfprobeStream[]; format?: FfprobeFormat }
        resolve({ streams: parsed.streams ?? [], format: parsed.format ?? {} })
      } catch (error) {
        reject(error instanceof Error ? error : new Error('ffprobe 输出解析失败'))
      }
    })
  })
}

function decideStrategy(ext: string, videoCodec: string, audioCodec: string): MediaStrategy {
  if (!videoCodec) return 'unsupported'

  const nativeCodec = CHROMIUM_VIDEO.has(videoCodec) && (audioCodec === '' || CHROMIUM_AUDIO.has(audioCodec))
  if (isNativeContainer(ext) && nativeCodec) return 'direct'

  if (MP4_VIDEO.has(videoCodec) || WEBM_VIDEO.has(videoCodec)) return 'remux'

  return 'transcode'
}

function describe(strategy: MediaStrategy, videoCodec: string, audioCodec: string): string {
  const v = videoCodec ? videoCodec.toUpperCase() : '未知'
  const a = audioCodec ? audioCodec.toUpperCase() : '无音轨'
  switch (strategy) {
    case 'direct':
      return `原生支持（${v} / ${a}）`
    case 'remux':
      return `需转换封装格式（${v} / ${a}）`
    case 'transcode':
      return `需转码为 H.264（${v} / ${a}）`
    default:
      return `不支持的编码（${v} / ${a}）`
  }
}

function makeProbe(
  ok: boolean,
  container: string,
  videoCodec: string,
  audioCodec: string,
  duration: number,
  width: number,
  height: number,
  strategy: MediaStrategy,
  message: string
): MediaProbe {
  return { ok, container, videoCodec, audioCodec, duration, width, height, strategy, message }
}

export async function probeFile(filePath: string): Promise<MediaProbe> {
  const ext = extOfPath(filePath)

  let size = 0
  let mtime = 0
  try {
    const stat = await fs.stat(filePath)
    size = stat.size
    mtime = stat.mtimeMs
  } catch {
    return makeProbe(false, ext, '', '', 0, 0, 0, 'unsupported', '文件不存在或无法访问')
  }

  const key = `${filePath}|${size}|${mtime}`
  const cached = probeCache.get(key)
  if (cached) return cached

  const ffprobe = resolveBinary('ffprobe')
  if (!ffprobe) {
    const strategy: MediaStrategy = isNativeContainer(ext) ? 'direct' : 'unsupported'
    return makeProbe(
      true,
      ext,
      '',
      '',
      0,
      0,
      0,
      strategy,
      strategy === 'direct' ? '' : '缺少 FFmpeg，无法处理该封装格式'
    )
  }

  let result: { streams: FfprobeStream[]; format: FfprobeFormat }
  try {
    result = await runFfprobe(ffprobe, filePath)
  } catch (error) {
    return makeProbe(
      false,
      ext,
      '',
      '',
      0,
      0,
      0,
      'unsupported',
      `无法解析该文件：${error instanceof Error ? error.message : '未知错误'}`
    )
  }

  const video = result.streams.find((stream) => stream.codec_type === 'video')
  const audio = result.streams.find((stream) => stream.codec_type === 'audio')

  const videoCodec = (video?.codec_name ?? '').toLowerCase()
  const audioCodec = (audio?.codec_name ?? '').toLowerCase()
  const container = (result.format.format_name ?? ext).split(',')[0]
  const strategy = decideStrategy(ext, videoCodec, audioCodec)

  const probe = makeProbe(
    videoCodec !== '',
    container,
    videoCodec,
    audioCodec,
    Number(result.format.duration ?? 0) || 0,
    video?.width ?? 0,
    video?.height ?? 0,
    strategy,
    videoCodec === '' ? '该文件不包含可播放的视频轨道' : describe(strategy, videoCodec, audioCodec)
  )

  if (probeCache.size >= PROBE_CACHE_LIMIT) probeCache.clear()
  probeCache.set(key, probe)
  return probe
}

/* ------------------------------------------------------------------ *
 * ffmpeg 转换
 * ------------------------------------------------------------------ */

function buildArgs(
  input: string,
  output: string,
  strategy: MediaStrategy,
  videoCodec: string,
  audioCodec: string,
  forceTranscode: boolean
): { args: string[]; useWebm: boolean } {
  const args = ['-hide_banner', '-nostdin', '-y', '-i', input, '-map', '0:v:0', '-map', '0:a:0?']

  if (strategy === 'transcode' || forceTranscode) {
    args.push(
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '20',
      '-pix_fmt',
      'yuv420p',
      '-vf',
      "scale='min(1920,iw)':-2",
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-movflags',
      '+faststart',
      '-max_muxing_queue_size',
      '2048',
      '-f',
      'mp4',
      output
    )
    return { args, useWebm: false }
  }

  const useWebm = WEBM_VIDEO.has(videoCodec)
  args.push('-c:v', 'copy')
  if (videoCodec === 'hevc') args.push('-tag:v', 'hvc1')

  if (audioCodec === '') {
    args.push('-an')
  } else if (useWebm) {
    if (audioCodec === 'opus' || audioCodec === 'vorbis') args.push('-c:a', 'copy')
    else args.push('-c:a', 'libopus', '-b:a', '160k')
  } else if (audioCodec === 'aac' || audioCodec === 'mp3') {
    args.push('-c:a', 'copy')
  } else {
    args.push('-c:a', 'aac', '-b:a', '192k')
  }

  args.push('-max_muxing_queue_size', '2048')
  if (useWebm) args.push('-f', 'webm', output)
  else args.push('-movflags', '+faststart', '-f', 'mp4', output)

  return { args, useWebm }
}

function parseTimeToSeconds(text: string): number {
  const match = /(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(text)
  if (!match) return 0
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
}

export interface PrepareOptions {
  forceTranscode?: boolean
}

export function prepareFile(
  filePath: string,
  options: PrepareOptions = {},
  onProgress?: (progress: PrepareProgress) => void
): Promise<PrepareResult> {
  const handleKey = `${filePath}|${options.forceTranscode ? 'force' : 'auto'}`
  const existing = inFlight.get(handleKey)
  if (existing) return existing

  const task = runPrepare(filePath, options, onProgress).finally(() => inFlight.delete(handleKey))
  inFlight.set(handleKey, task)
  return task
}

async function runPrepare(
  filePath: string,
  options: PrepareOptions,
  onProgress?: (progress: PrepareProgress) => void
): Promise<PrepareResult> {
  const ffmpeg = resolveBinary('ffmpeg')
  if (!ffmpeg) {
    return {
      ok: false,
      path: '',
      cached: false,
      strategy: 'unsupported',
      message: '未找到 FFmpeg，无法转换该视频格式'
    }
  }

  const probe = await probeFile(filePath)
  const forceTranscode = options.forceTranscode === true
  const strategy: MediaStrategy = forceTranscode ? 'transcode' : probe.strategy

  if (!forceTranscode && (strategy === 'direct' || strategy === 'unsupported')) {
    return {
      ok: false,
      path: '',
      cached: false,
      strategy,
      message: probe.message || '该视频无法转换'
    }
  }

  let size = 0
  let mtime = 0
  try {
    const stat = await fs.stat(filePath)
    size = stat.size
    mtime = stat.mtimeMs
  } catch {
    return { ok: false, path: '', cached: false, strategy, message: '文件不存在或无法访问' }
  }

  const stage: PrepareProgress['stage'] = strategy === 'transcode' ? 'transcode' : 'remux'
  const { args, useWebm } = buildArgs(
    filePath,
    '', // 输出路径稍后拼装，这里仅用于推断容器
    strategy,
    probe.videoCodec,
    probe.audioCodec,
    forceTranscode
  )
  const extension = strategy === 'transcode' || forceTranscode ? 'mp4' : useWebm ? 'webm' : 'mp4'

  const dir = await ensureCacheDir()
  const key = cacheKey(
    filePath,
    size,
    mtime,
    `${strategy}:${probe.videoCodec}:${probe.audioCodec}:${extension}`
  )
  const target = join(dir, `${safeName(filePath)}-${key}.${extension}`)

  try {
    const stat = await fs.stat(target)
    if (stat.size > 0) {
      await fs.utimes(target, new Date(), new Date()).catch(() => undefined)
      onProgress?.({ path: filePath, percent: 100, stage, speed: '', state: 'done', message: '已使用本地缓存' })
      return { ok: true, path: target, cached: true, strategy, message: '已使用本地缓存' }
    }
  } catch {
    /* 缓存未命中，继续转换 */
  }

  args[args.length - 1] = target

  onProgress?.({
    path: filePath,
    percent: 0,
    stage,
    speed: '',
    state: 'running',
    message: stage === 'transcode' ? '正在转码…' : '正在转换封装格式…'
  })

  const handleKey = `${filePath}|${forceTranscode ? 'force' : 'auto'}`

  const outcome = await new Promise<{ ok: boolean; canceled: boolean; message: string }>((resolve) => {
    const child: ChildProcess = spawn(ffmpeg, args, { windowsHide: true })

    let stderrTail = ''
    let lastEmit = 0
    let canceled = false

    cancelHandles.set(handleKey, () => {
      canceled = true
      child.kill('SIGKILL')
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stderrTail = (stderrTail + text).slice(-2000)

      const now = Date.now()
      if (!onProgress || now - lastEmit < PROGRESS_THROTTLE_MS) return
      lastEmit = now

      const timeMatch = /time=(\d+:\d{2}:\d{2}(?:\.\d+)?)/.exec(text)
      if (!timeMatch) return

      const seconds = parseTimeToSeconds(timeMatch[1])
      const percent = probe.duration > 0 ? Math.min(99, Math.round((seconds / probe.duration) * 100)) : 0
      const speedMatch = /speed=\s*([\d.]+x)/.exec(text)

      onProgress({
        path: filePath,
        percent,
        stage,
        speed: speedMatch?.[1] ?? '',
        state: 'running',
        message: stage === 'transcode' ? '正在转码…' : '正在转换封装格式…'
      })
    })

    child.on('error', (error) => resolve({ ok: false, canceled: false, message: `FFmpeg 启动失败：${error.message}` }))

    child.on('close', (code) => {
      cancelHandles.delete(handleKey)
      if (canceled) {
        resolve({ ok: false, canceled: true, message: '已取消' })
        return
      }
      if (code === 0) {
        resolve({ ok: true, canceled: false, message: '' })
        return
      }
      const tail = stderrTail
        .split('\n')
        .filter((line) => line.trim())
        .slice(-4)
        .join(' ')
      resolve({ ok: false, canceled: false, message: tail || `FFmpeg 退出码 ${code}` })
    })
  })

  if (!outcome.ok) {
    await fs.unlink(target).catch(() => undefined)
    onProgress?.({
      path: filePath,
      percent: 0,
      stage,
      speed: '',
      state: outcome.canceled ? 'canceled' : 'error',
      message: outcome.message
    })
    return { ok: false, path: '', cached: false, strategy, message: outcome.message }
  }

  onProgress?.({ path: filePath, percent: 100, stage, speed: '', state: 'done', message: '转换完成' })
  void pruneCache()

  return { ok: true, path: target, cached: false, strategy, message: '转换完成' }
}

export function cancelPrepare(filePath: string): boolean {
  let hit = false
  for (const key of [`${filePath}|auto`, `${filePath}|force`]) {
    const cancel = cancelHandles.get(key)
    if (cancel) {
      cancel()
      cancelHandles.delete(key)
      hit = true
    }
  }
  return hit
}

/** 应用退出时终止所有仍在运行的转换进程 */
export function killAllPreparations(): void {
  for (const cancel of cancelHandles.values()) cancel()
  cancelHandles.clear()
}

export async function clearMediaCache(): Promise<number> {
  const dir = cacheDir()
  let removed = 0
  try {
    const entries = await fs.readdir(dir)
    for (const name of entries) {
      try {
        await fs.unlink(join(dir, name))
        removed++
      } catch {
        /* 忽略 */
      }
    }
  } catch {
    /* 目录不存在 */
  }
  probeCache.clear()
  return removed
}

export async function mediaCacheSize(): Promise<number> {
  const dir = cacheDir()
  let total = 0
  try {
    const entries = await fs.readdir(dir)
    for (const name of entries) {
      try {
        const stat = await fs.stat(join(dir, name))
        if (stat.isFile()) total += stat.size
      } catch {
        /* 忽略 */
      }
    }
  } catch {
    /* 目录不存在 */
  }
  return total
}
