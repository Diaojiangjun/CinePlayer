/**
 * 苹果CMS（MacCMS V10）采集接口的共享类型与纯函数。
 *
 * 该协议被绝大多数中文影视站点采用：`{站点}/api.php/provide/vod/`，
 * 默认输出 XML，也常支持 `&at=json` 输出 JSON。
 * 主进程负责把两种格式归一化成这里定义的结构，渲染层只面向本文件的类型。
 */

export interface MacClass {
  id: string
  name: string
  pid: string
}

export interface MacEpisode {
  name: string
  url: string
}

/** 一个播放源（线路），内部按集/话排列 */
export interface MacPlayGroup {
  name: string
  episodes: MacEpisode[]
}

export interface MacVod {
  vodId: string
  name: string
  typeId: string
  typeName: string
  pic: string
  lang: string
  area: string
  year: string
  state: string
  note: string
  actor: string
  director: string
  score: string
  content: string
  /** 总集数，0 表示未知 */
  total: number
  /** 已更新集数，0 表示未知 */
  serial: number
  playGroups: MacPlayGroup[]
}

export interface MacPage {
  page: number
  pageCount: number
  pageSize: number
  total: number
}

export interface MacListResult extends MacPage {
  classes: MacClass[]
  vods: MacVod[]
}

export interface MacDetailResult {
  classes: MacClass[]
  vod: MacVod | null
}

/**
 * 封面补全用的最小投影。
 *
 * 苹果CMS 的列表接口（`ac=list`）在多数站点上**不返回 `vod_pic`** —— 它只给
 * id / 名称 / 分类 / 备注这类轻量字段，封面只有详情接口（`ac=detail`）才带。
 * 所以列表页需要按 id 批量补一次封面，这里只留下 id 与图片地址。
 */
export interface MacPoster {
  vodId: string
  pic: string
}

/** 采集请求的统一返回包装 */
export interface MacResult<T> {
  ok: boolean
  data?: T
  error?: string
}

export interface MacListQuery {
  typeId?: string
  page?: number
  keyword?: string
  /** 最近 N 小时更新 */
  hours?: number
}

/* ------------------------------------------------------------------ *
 * URL 归一化
 * ------------------------------------------------------------------ */

const DEFAULT_PATH = '/api.php/provide/vod/'

/**
 * 把用户输入的各种写法统一成接口根地址。
 * 支持 `example.com`、`https://example.com`、`https://example.com/api.php/provide/vod`、
 * 以及直接粘贴的列表地址 `.../vod/?ac=list&pg=2`。
 */
export function normalizeApiUrl(raw: string): string {
  const input = (raw || '').trim()
  if (!input) return ''

  let url = input
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`
  // 直接粘接口地址时把查询串丢掉
  url = url.split('#')[0].split('?')[0]

  if (/\/api\.php/i.test(url)) {
    url = url.replace(/\/+$/, '') + '/'
  } else {
    url = url.replace(/\/+$/, '') + DEFAULT_PATH
  }
  return url
}

export interface MacQuery {
  ac: 'list' | 'detail' | 'videolist'
  typeId?: string
  page?: number
  keyword?: string
  /** 最近 N 小时更新 */
  hours?: number
  /** 指定影片 id，多个逗号分隔 */
  ids?: string
}

export function buildApiUrl(apiUrl: string, query: MacQuery): string {
  const base = normalizeApiUrl(apiUrl)
  if (!base) return ''
  const params = new URLSearchParams()
  params.set('ac', query.ac)
  if (query.typeId) params.set('t', query.typeId)
  if (query.page && query.page > 0) params.set('pg', String(query.page))
  if (query.keyword) params.set('wd', query.keyword)
  if (query.hours && query.hours > 0) params.set('h', String(query.hours))
  if (query.ids) params.set('ids', query.ids)
  return `${base}?${params.toString()}`
}

/* ------------------------------------------------------------------ *
 * 播放地址解析
 * ------------------------------------------------------------------ */

const GROUP_SEP = '$$$'
const EPISODE_SEP = '#'

function isPlayableUrl(text: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^\/\//.test(text) || /\.(m3u8|mp4|flv|ts)(\?|#|$)/i.test(text)
}

/** 单条 `名称$地址` 记录；少数站点会把地址写在前面，这里都兼容 */
export function parseEpisode(raw: string): MacEpisode | null {
  const text = (raw || '').trim()
  if (!text) return null

  const index = text.indexOf('$')
  if (index < 0) return isPlayableUrl(text) ? { name: text, url: text } : null

  let name = text.slice(0, index).trim()
  let url = text.slice(index + 1).trim()
  if (!isPlayableUrl(url) && isPlayableUrl(name)) {
    const swap = name
    name = url
    url = swap
  }
  if (!isPlayableUrl(url)) return null
  return { name: name || url, url }
}

/**
 * 把 `vod_play_from` / `vod_play_url` 两段字符串拆成结构化线路。
 * 线路之间用 `$$$` 分隔，线路内各集用 `#` 分隔，集名与地址用 `$` 分隔。
 */
export function splitPlayGroups(playFrom: string, playUrl: string): MacPlayGroup[] {
  const urlChunks = (playUrl || '').split(GROUP_SEP)
  const fromChunks = (playFrom || '').split(GROUP_SEP)
  const groups: MacPlayGroup[] = []

  urlChunks.forEach((chunk, index) => {
    const episodes = chunk
      .split(EPISODE_SEP)
      .map((item) => parseEpisode(item))
      .filter((item): item is MacEpisode => item !== null)
    if (!episodes.length) return

    const label = (fromChunks[index] || '').trim()
    groups.push({ name: label || `线路${groups.length + 1}`, episodes })
  })

  return groups
}

/* ------------------------------------------------------------------ *
 * 杂项归一化
 * ------------------------------------------------------------------ */

export function toStr(value: unknown): string {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

export function toNum(value: unknown): number {
  const num = Number(String(value ?? '').replace(/[^\d.-]/g, ''))
  return Number.isFinite(num) ? num : 0
}

/** 采集站返回的封面常见 `//` 协议相对地址与相对路径，这里补全 */
export function resolveImageUrl(pic: string, apiUrl: string): string {
  const value = (pic || '').trim()
  if (!value) return ''
  if (/^https?:\/\//i.test(value)) return value
  let origin = ''
  try {
    origin = new URL(normalizeApiUrl(apiUrl)).origin
  } catch {
    origin = ''
  }
  if (value.startsWith('//')) return `https:${value}`
  if (value.startsWith('/')) return origin ? `${origin}${value}` : value
  return origin ? `${origin}/${value}` : value
}

/** 只保留字母数字与中文，用于生成本地稳定 key */
export function vodKey(siteId: number, vodId: string): string {
  return `${siteId}:${vodId}`
}
