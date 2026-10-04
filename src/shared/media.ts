/**
 * 主进程 / 预加载 / 渲染进程共享的媒体常量与工具。
 *
 * 本地文件统一通过自定义协议 `cine-file://` 交给渲染进程：
 * 主进程负责按 HTTP Range 读取字节，渲染进程只拿到一个普通 URL，
 * 既避开了 `file://` 在 http 源页面下的跨源限制，也让拖动进度条能精确 seek。
 */

export const MEDIA_SCHEME = 'cine-file'
export const MEDIA_HOST = 'local'

/** 被识别为视频的扩展名（是否真的能播由 ffprobe 决定） */
export const VIDEO_EXTENSIONS = [
  'mp4',
  'mkv',
  'avi',
  'mov',
  'm4v',
  'webm',
  'ogv',
  'ogg',
  'wmv',
  'flv',
  'rmvb',
  'rm',
  'asf',
  'f4v',
  'vob',
  'divx',
  'ts',
  'm2ts',
  'mts',
  '3gp',
  'mpg',
  'mpeg'
]

const VIDEO_EXT_SET = new Set(VIDEO_EXTENSIONS.map((e) => `.${e}`))

/** Chromium 自带解复用器的封装格式；其余封装必须先交给 ffmpeg 转换 */
const NATIVE_CONTAINERS = new Set(['mp4', 'm4v', 'webm', 'ogv', 'ogg'])

const CONTAINER_MIME: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  wmv: 'video/x-ms-wmv',
  flv: 'video/x-flv',
  ogv: 'video/ogg',
  ogg: 'video/ogg',
  ts: 'video/mp2t',
  m2ts: 'video/mp2t',
  mts: 'video/mp2t',
  rmvb: 'application/vnd.rn-realmedia-vbr',
  rm: 'application/vnd.rn-realmedia',
  asf: 'video/x-ms-asf',
  f4v: 'video/mp4',
  vob: 'video/dvd',
  divx: 'video/divx',
  '3gp': 'video/3gpp',
  mpg: 'video/mpeg',
  mpeg: 'video/mpeg'
}

export type MediaStrategy = 'direct' | 'remux' | 'transcode' | 'unsupported'

export interface MediaProbe {
  ok: boolean
  /** 真实封装名（可能与扩展名不一致） */
  container: string
  videoCodec: string
  audioCodec: string
  duration: number
  width: number
  height: number
  strategy: MediaStrategy
  message: string
}

export interface MediaCapabilities {
  ffmpeg: boolean
  ffprobe: boolean
}

export interface PrepareProgress {
  path: string
  percent: number
  stage: 'remux' | 'transcode'
  speed: string
  state: 'running' | 'done' | 'error' | 'canceled'
  message: string
}

export interface PrepareResult {
  ok: boolean
  path: string
  cached: boolean
  strategy: MediaStrategy
  message: string
}

export function extOfPath(filePath: string): string {
  const dot = filePath.lastIndexOf('.')
  return dot > 0 ? filePath.slice(dot + 1).toLowerCase() : ''
}

export function baseNameOfPath(filePath: string): string {
  return filePath.split(/[\\/]/).pop() ?? filePath
}

export function titleOfPath(filePath: string): string {
  const base = baseNameOfPath(filePath)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(0, dot) : base
}

export function dirOfPath(filePath: string): string {
  return filePath.replace(/[\\/][^\\/]*$/, '')
}

export function isVideoPath(filePath: string): boolean {
  const dot = filePath.lastIndexOf('.')
  return dot > 0 && VIDEO_EXT_SET.has(filePath.slice(dot).toLowerCase())
}

export function isNativeContainer(ext: string): boolean {
  return NATIVE_CONTAINERS.has(ext)
}

export function mimeOfPath(filePath: string): string {
  return CONTAINER_MIME[extOfPath(filePath)] ?? 'application/octet-stream'
}

/* ------------------------------------------------------------------ *
 * URL 编解码
 * ------------------------------------------------------------------ */

/**
 * 把绝对路径编码进 cine-file:// 的路径段。
 * 采用 base64url：中文、空格、`#`、`?`、`%`、反斜杠都不会被 URL 规范化破坏。
 */
export function encodeMediaPath(filePath: string): string {
  const bytes = new TextEncoder().encode(filePath)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function decodeMediaPath(segment: string): string {
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/')
  const padLength = (4 - (base64.length % 4)) % 4
  const binary = atob(base64 + '='.repeat(padLength))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

export function toMediaUrl(filePath: string): string {
  return `${MEDIA_SCHEME}://${MEDIA_HOST}/${encodeMediaPath(filePath)}`
}

export function mediaUrlToPath(url: string): string | null {
  const prefix = `${MEDIA_SCHEME}://`
  if (!url.startsWith(prefix)) return null
  const rest = url.slice(prefix.length)
  const slash = rest.indexOf('/')
  if (slash < 0) return null
  const segment = rest.slice(slash + 1).split(/[?#]/)[0]
  if (!segment) return null
  try {
    const decoded = decodeMediaPath(segment)
    return decoded || null
  } catch {
    return null
  }
}
