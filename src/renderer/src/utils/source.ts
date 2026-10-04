import { toMediaUrl } from '../../../shared/media'

export { toMediaUrl }

export function isStreamUrl(src: string): boolean {
  return /^(https?|rtsp|rtmp|rtmps|mms):\/\//i.test(src)
}

export function isHlsUrl(src: string): boolean {
  return /\.m3u8(\?|#|$)/i.test(src)
}

/** Chromium 内核无法解析的传统流协议 */
export function isLegacyStreamProtocol(src: string): boolean {
  return /^(rtmp|rtmps|rtsp|mms):\/\//i.test(src)
}

const NATIVE_MEDIA_RE = /\.(mp4|m4v|webm|ogv|ogg|mov|flv|mkv|avi|mp3|aac|m4a)(\?|#|$)/i

/**
 * 是否交给 hls.js 处理。
 *
 * IPTV 直播地址普遍不带扩展名，且 `.ts` 也不能被 <video> 直接播放，
 * 因此除明确的原生容器外一律按 HLS 处理；若 HLS 失败会回退到原生播放。
 */
export function shouldUseHls(src: string): boolean {
  if (!/^https?:\/\//i.test(src)) return false
  if (isHlsUrl(src)) return true
  return !NATIVE_MEDIA_RE.test(src)
}

/** 去掉路径中的目录与扩展名，得到可展示的标题 */
export function fileNameOf(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() ?? filePath
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(0, dot) : base
}
