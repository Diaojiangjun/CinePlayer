/**
 * 「分享页」播放地址解析。
 *
 * 很多站点的播放地址并不是一个能直接播的媒体链接，而是一个**网页**：
 *
 *   https://share.example.com/share/abc123def456
 *
 * 这个地址在浏览器里能正常播放，因为它返回的是 HTML，真正的播放地址写在页面内联脚本里：
 *
 *   var main = "/20260101/12345_abcdef01/index.m3u8?sign=0123456789abcdef";
 *
 * 注意它是**相对路径**，必须按页面地址（而不是站点根）拼成绝对地址。
 * 这类地址直接丢给 hls.js 只会得到 manifest 解析错误 —— 用户看到的就是「播不了」。
 *
 * 这里把「判定是否值得探测」与「从 HTML 里挖出真实地址」做成纯函数，便于离线断言。
 */

/**
 * 一眼能看出是媒体文件的扩展名。
 * 命中就不必再去探测「这是不是一个网页」，省掉一次网络往返。
 */
const MEDIA_EXT_RE =
  /\.(m3u8|m3u|mpd|mp4|m4v|webm|ogv|ogg|mov|mkv|avi|flv|f4v|ts|m4s|mp3|aac|m4a|flac|wav)(?:[?#]|$)/i

/** 明显是静态资源或页面本身，不能当成播放地址 */
const ASSET_EXT_RE =
  /\.(js|mjs|css|json|xml|html?|php|aspx?|jsp|jpe?g|png|gif|webp|bmp|svg|ico|woff2?|ttf|eot|map|txt)(?:[?#]|$)/i

/**
 * 常见的播放地址变量名，越靠前越可信。
 *
 * `main` 排在第一位是有依据的：海洋 / 苹果 CMS 系分享页统一用 `var main = "..."`。
 */
const PLAYBACK_KEYS = [
  'main',
  'm3u8',
  'm3u8url',
  'videourl',
  'playurl',
  'sourceurl',
  'hlsurl',
  'source',
  'hls',
  'video',
  'vurl',
  'file',
  'src',
  'url'
]

export interface StreamCandidate {
  url: string
  /** 是否来自已知的播放变量名 —— 全文里随便扫到的链接可信度低得多 */
  trusted: boolean
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 页面里的两种转义：JSON 的 `\/` 与 HTML 实体的 `&amp;` */
function normalizeMarkup(html: string): string {
  return html
    .replace(/\\u002[fF]/g, '/')
    .replace(/\\\//g, '/')
    .replace(/&amp;/gi, '&')
}

/** 响应体是不是一份 HLS 播放列表 */
export function isM3u8Body(text: string): boolean {
  return /^\s*#EXTM3U/.test(text)
}

/**
 * 探测结果的归类。
 * 先看播放列表特征再判 HTML：`#EXTM3U` 是极强信号，
 * 有些服务器会把 m3u8 标成 `text/html` 或 `text/plain`。
 */
export function classifyProbe(text: string, contentType: string): 'playlist' | 'html' | 'other' {
  if (isM3u8Body(text)) return 'playlist'
  if (/text\/html|application\/xhtml/i.test(contentType)) return 'html'

  const head = text.slice(0, 1024).trimStart().toLowerCase()
  if (head.startsWith('<!doctype html') || head.startsWith('<html') || /<html[\s>]/.test(head)) {
    return 'html'
  }
  return 'other'
}

/**
 * 是否值得抓下来看看「这是不是一个分享页」。
 *
 * 判据只看路径末段有没有媒体扩展名 —— 只对**可能产生歧义**的地址付出一次探测成本，
 * 正常的 `.m3u8` / `.mp4` 直链完全不受影响。
 * 无扩展名的 IPTV 直播地址也会被探一次，但探测结果本身就是播放列表，直接原样播即可。
 */
export function mightBeSharePage(rawUrl: string): boolean {
  if (!/^https?:\/\//i.test(rawUrl)) return false
  let pathname: string
  try {
    pathname = new URL(rawUrl).pathname
  } catch {
    return false
  }
  return !MEDIA_EXT_RE.test(pathname)
}

/**
 * 把候选值补成绝对地址。
 *
 * 必须按 `pageUrl` 解析而不是站点根：分享页常常挂在 `/share/xxx` 这类子路径下。
 */
function absolutize(candidate: string, pageUrl: string): string | null {
  const value = candidate.trim().replace(/^['"`]|['"`]$/g, '')
  if (value.length < 4 || value.startsWith('#')) return null

  // Chromium 内核放不了这些协议，别把它们当候选
  if (/^(rtmp|rtmps|rtsp|mms):\/\//i.test(value)) return null

  try {
    const resolved = new URL(value, pageUrl)
    // 统一挡掉 javascript: / data: / mailto: 之类
    return /^https?:\/\//i.test(resolved.href) ? resolved.href : null
  } catch {
    return null
  }
}

/**
 * 从 `var main = "..."` / `"main": "..."` 这类写法里取候选值。
 *
 * 变量名必须带**词边界**：否则 `url` 会命中 `redirecturl` / `tracker_url`
 * 这类广告与统计地址 —— 实测某些分享页的 `redirecturl` 直接指向广告站。
 */
function matchKeyValues(markup: string, key: string): string[] {
  const pattern = new RegExp(
    `(?:^|[^\\w$])${escapeRe(key)}\\s*[:=]\\s*["'\`]([^"'\`\\s<>]{4,})["'\`]`,
    'gi'
  )
  const found: string[] = []
  let match: RegExpExecArray | null
  while ((match = pattern.exec(markup)) !== null) found.push(match[1])
  return found
}

/** 全文里带引号的媒体链接（绝对地址与相对路径都算） */
function matchMediaLinks(markup: string): string[] {
  const pattern = /["'`]([^"'`\s<>]{4,})["'`]/g
  const found: string[] = []
  let match: RegExpExecArray | null
  while ((match = pattern.exec(markup)) !== null) {
    if (MEDIA_EXT_RE.test(match[1])) found.push(match[1])
  }
  return found
}

function looksLikeMedia(url: string): boolean {
  try {
    const parsed = new URL(url)
    return MEDIA_EXT_RE.test(parsed.pathname) || MEDIA_EXT_RE.test(parsed.search)
  } catch {
    return false
  }
}

function looksLikeAsset(url: string): boolean {
  try {
    return ASSET_EXT_RE.test(new URL(url).pathname)
  } catch {
    return true
  }
}

/** 按可信度收集候选地址 */
export function collectStreamCandidates(html: string, pageUrl: string): StreamCandidate[] {
  const markup = normalizeMarkup(html)
  const candidates: StreamCandidate[] = []

  for (const key of PLAYBACK_KEYS) {
    for (const raw of matchKeyValues(markup, key)) {
      const url = absolutize(raw, pageUrl)
      if (url) candidates.push({ url, trusted: true })
    }
  }

  for (const raw of matchMediaLinks(markup)) {
    const url = absolutize(raw, pageUrl)
    if (url) candidates.push({ url, trusted: false })
  }

  return candidates
}

/**
 * 从分享页 HTML 里挖出可直接播放的地址；挖不到返回 `null`。
 *
 * 三级优先：
 *  1. 已知播放变量名 + 带媒体扩展名（最可信，实测分享页走的都是这条）
 *  2. 全文里任意带媒体扩展名的链接
 *  3. 已知播放变量名 + 不是静态资源（应付 `var main = "https://cdn.x/live/abc"` 这种无扩展名的真实流）
 *
 * 第 3 级刻意不接受「全文随便扫到的无扩展名链接」—— 那基本只会捞到广告跳转地址，
 * 与其静默播一个广告，不如老老实实报错。
 */
export function extractStreamUrl(html: string, pageUrl: string): string | null {
  const candidates = collectStreamCandidates(html, pageUrl)

  const hit =
    candidates.find((item) => item.trusted && looksLikeMedia(item.url)) ??
    candidates.find((item) => looksLikeMedia(item.url)) ??
    candidates.find((item) => item.trusted && !looksLikeAsset(item.url))

  return hit?.url ?? null
}
