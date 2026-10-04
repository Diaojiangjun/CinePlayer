import type {
  MacClass,
  MacDetailResult,
  MacListQuery,
  MacListResult,
  MacPoster,
  MacResult,
  MacVod
} from '../shared/maccms'
import { buildApiUrl, normalizeApiUrl } from '../shared/maccms'
import { looksLikeHtml, parseMacPayload, parseMacPics } from '../shared/maccms-parse'
import { fetchText, type FetchOptions } from './net/http'

/**
 * 苹果CMS（MacCMS V10）采集接口客户端（仅负责网络，报文解析在 shared/maccms-parse.ts）。
 */

export type { MacListQuery, MacResult }

async function request(
  apiUrl: string,
  query: Parameters<typeof buildApiUrl>[1],
  options?: FetchOptions
): Promise<{ ok: boolean; payload?: ReturnType<typeof parseMacPayload>; error?: string }> {
  const url = buildApiUrl(apiUrl, query)
  if (!url) return { ok: false, error: '接口地址为空' }

  const response = await fetchText(url, options)
  if (!response.ok) return { ok: false, error: response.error || '请求接口失败' }
  if (!response.text.trim()) return { ok: false, error: '接口返回了空内容' }
  if (looksLikeHtml(response.text)) {
    return { ok: false, error: '该地址返回的是网页而非采集数据，请确认接口路径正确' }
  }

  try {
    return { ok: true, payload: parseMacPayload(response.text, apiUrl) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : '采集数据解析失败' }
  }
}

/** 分类随列表接口一起返回，取第一页即可拿到完整分类树 */
export async function fetchClasses(apiUrl: string, options?: FetchOptions): Promise<MacClass[]> {
  const result = await request(apiUrl, { ac: 'list', page: 1 }, options)
  return result.payload?.classes ?? []
}

export async function fetchList(
  apiUrl: string,
  query: MacListQuery = {},
  options?: FetchOptions
): Promise<MacResult<MacListResult>> {
  if (!normalizeApiUrl(apiUrl)) return { ok: false, error: '接口地址为空' }

  const result = await request(
    apiUrl,
    {
      ac: 'list',
      typeId: query.typeId,
      page: query.page && query.page > 0 ? query.page : 1,
      keyword: query.keyword,
      hours: query.hours
    },
    options
  )

  if (!result.ok || !result.payload) return { ok: false, error: result.error }
  const { classes, vods, page } = result.payload
  return { ok: true, data: { ...page, classes, vods } }
}

/** 一次补封面请求最多带多少个 id，避免 URL 过长被网关拒绝 */
const PIC_BATCH = 50

/**
 * 按 id 批量取封面。
 *
 * `ac=list` 只返回轻量字段、没有 `vod_pic`，所以列表页渲染后要补一次。
 * 这里刻意不复用 `request()`：那条路径会把整页的 `vod_play_url` 拆成剧集对象，
 * 而我们只要封面，用 `parseMacPics` 可以跳过这部分解析。
 * 站点若忽略 `ids` 参数（返回的不是我们要的影片），按 id 匹配不到就自然留空，不会出错。
 */
export async function fetchPics(
  apiUrl: string,
  ids: string[],
  options?: FetchOptions
): Promise<MacResult<MacPoster[]>> {
  if (!normalizeApiUrl(apiUrl)) return { ok: false, error: '接口地址为空' }

  const clean = [...new Set(ids.map((id) => (id || '').trim()).filter(Boolean))]
  if (!clean.length) return { ok: true, data: [] }

  const posters: MacPoster[] = []
  for (let start = 0; start < clean.length; start += PIC_BATCH) {
    const chunk = clean.slice(start, start + PIC_BATCH)
    const url = buildApiUrl(apiUrl, { ac: 'detail', ids: chunk.join(',') })
    if (!url) return { ok: false, error: '接口地址为空' }

    const response = await fetchText(url, options)
    if (!response.ok) return { ok: false, error: response.error || '请求接口失败' }
    if (!response.text.trim()) return { ok: false, error: '接口返回了空内容' }
    if (looksLikeHtml(response.text)) {
      return { ok: false, error: '该地址返回的是网页而非采集数据，请确认接口路径正确' }
    }

    try {
      posters.push(...parseMacPics(response.text, apiUrl))
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '采集数据解析失败' }
    }
  }

  return { ok: true, data: posters }
}

export async function fetchDetail(
  apiUrl: string,
  vodId: string,
  options?: FetchOptions
): Promise<MacResult<MacDetailResult>> {
  if (!normalizeApiUrl(apiUrl)) return { ok: false, error: '接口地址为空' }
  if (!vodId) return { ok: false, error: '缺少影片 id' }

  let result = await request(apiUrl, { ac: 'detail', ids: vodId }, options)

  // 老版本接口只有 videolist
  if (result.ok && result.payload && !result.payload.vods.length) {
    result = await request(apiUrl, { ac: 'videolist', ids: vodId }, options)
  }

  if (!result.ok || !result.payload) return { ok: false, error: result.error }

  const vod: MacVod | null =
    result.payload.vods.find((item) => item.vodId === vodId) ?? result.payload.vods[0] ?? null

  if (!vod) return { ok: false, error: '该影片没有可播放的剧集数据' }
  return { ok: true, data: { classes: result.payload.classes, vod } }
}
