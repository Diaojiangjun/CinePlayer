import { fetchText } from './net/http'
import { classifyProbe, extractStreamUrl, mightBeSharePage } from '../shared/stream-resolve'

/**
 * 播放地址解析。
 *
 * 有一类播放地址是「网页」而不是媒体文件（形如 `https://host/share/<id>`）：
 * 浏览器里能直接播，是因为页面内联脚本里写着真正的 m3u8 地址。
 * 直接丢给 hls.js 只会报 manifest 解析错误，用户看到的就是「播不了」。
 *
 * 这里负责把这类地址解析成真正可播的地址，并把分享页地址登记下来 ——
 * 不少站点对分片做了 Referer 防盗链，后续请求需要带上它。
 */

export interface StreamResolveResult {
  ok: boolean
  /** 最终可直接播放的地址 */
  url: string
  /** direct = 原地址本身就能播；page = 从分享页里解析出来的 */
  from: 'direct' | 'page'
  /** 分享页地址，供排查与展示 */
  referer: string
  error: string
}

/** 按 origin 记住「这个站的流该带哪个 Referer」 */
const refererByOrigin = new Map<string, string>()

function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

/** 登记 Referer：解析出真实地址后，后续同源请求都带上分享页地址 */
export function rememberReferer(streamUrl: string, pageUrl: string): void {
  const origin = originOf(streamUrl)
  if (origin) refererByOrigin.set(origin, pageUrl)
}

/** 查询某个请求地址该补什么 Referer；没有登记过就返回空串（即不改动请求） */
export function refererFor(requestUrl: string): string {
  const origin = originOf(requestUrl)
  return origin ? (refererByOrigin.get(origin) ?? '') : ''
}

/** 仅供测试：清空登记表 */
export function clearRefererRegistry(): void {
  refererByOrigin.clear()
}

/** 探测分享页时只读前 512KB —— 超过这个体积的页面多半不是我们要找的东西 */
const PROBE_MAX_BYTES = 512 * 1024

/**
 * 探测超时。
 *
 * 只有**路径末段没有媒体扩展名**的地址才会走到这里（`.m3u8` / `.mp4` 直链零开销），
 * 代价是一次小请求：分享页几 KB、播放列表几十 KB。换来的是用户能立刻看到
 * 「正在解析播放地址…」，而不是对着一个永远转圈的播放器猜。
 * 超时也只是回到「按原地址播」的老行为，不会把原本能播的流弄坏。
 */
const PROBE_TIMEOUT = 8000

export async function resolveStreamSource(rawUrl: string): Promise<StreamResolveResult> {
  const direct: StreamResolveResult = {
    ok: true,
    url: rawUrl,
    from: 'direct',
    referer: '',
    error: ''
  }

  if (!/^https?:\/\//i.test(rawUrl)) {
    return { ok: false, url: '', from: 'direct', referer: '', error: '请填写 http/https 播放地址' }
  }

  // 带媒体扩展名的地址不必探测，省掉一次网络往返
  if (!mightBeSharePage(rawUrl)) return direct

  let response
  try {
    response = await fetchText(rawUrl, {
      timeout: PROBE_TIMEOUT,
      accept: 'text/html, application/xhtml+xml, */*',
      maxBytes: PROBE_MAX_BYTES
    })
  } catch (error) {
    return { ...direct, error: error instanceof Error ? error.message : '探测失败' }
  }

  // 探测失败不阻断：原样交给播放内核，行为和以前一致
  if (!response.ok || !response.text) return direct

  const kind = classifyProbe(response.text, response.contentType)
  // 无扩展名的 IPTV 直播地址就会走到这里：它本身就是播放列表，原样播即可
  if (kind !== 'html') return direct

  const pageUrl = response.finalUrl || rawUrl
  const found = extractStreamUrl(response.text, pageUrl)
  if (!found) {
    return {
      ok: false,
      url: '',
      from: 'page',
      referer: pageUrl,
      error: '这个页面里没有找到可直接播放的地址，可能使用了加密播放器'
    }
  }

  rememberReferer(found, pageUrl)
  return { ok: true, url: found, from: 'page', referer: pageUrl, error: '' }
}
