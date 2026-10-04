import { decodeEntities } from './entities'

/**
 * XMLTV 电子节目单解析（纯函数，主进程与渲染层共用）。
 *
 * EPG 文件动辄数十万条节目，用完整 DOM 解析既慢又吃内存，
 * 这里用扫描式正则，只保留「最近已播 + 未来一段时间」的节目。
 */

export interface EpgProgramme {
  title: string
  desc: string
  category: string
  start: number
  stop: number
}

export interface EpgData {
  /** channel id → 显示名称 */
  channels: Record<string, string>
  /** channel id → 按时间升序的节目 */
  programmes: Record<string, EpgProgramme[]>
}

/** EPG 拉取结果（含解析统计，便于界面反馈） */
export interface EpgFetchResult {
  ok: boolean
  data?: EpgData
  error?: string
  programmeCount: number
  channelCount: number
  bytes: number
}

/** M3U 订阅地址的拉取结果 */
export interface PlaylistFetchResult {
  ok: boolean
  content: string
  error: string
}

const PAST_WINDOW = 6 * 60 * 60 * 1000
const FUTURE_WINDOW = 48 * 60 * 60 * 1000
const MAX_PROGRAMMES = 200000

const CHANNEL_RE = /<channel\b([^>]*)>([\s\S]*?)<\/channel>/gi
const PROGRAMME_RE = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/gi
const ATTR_RE = /([\w:.-]+)\s*=\s*"([^"]*)"/g

function attrsOf(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  ATTR_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = ATTR_RE.exec(raw)) !== null) attrs[match[1].toLowerCase()] = match[2]
  return attrs
}

function tagText(body: string, tag: string): string {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(body)
  if (!match) return ''
  const raw = match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  return decodeEntities(raw).replace(/\s+/g, ' ').trim()
}

/** `20261001120000 +0800` → 毫秒时间戳 */
export function parseXmltvTime(raw: string): number {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?/.exec(
    (raw || '').trim()
  )
  if (!match) return 0

  const [, year, month, day, hour, minute, second, zone] = match
  let stamp = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second ?? '0')
  )
  if (zone) {
    const sign = zone.charAt(0) === '-' ? -1 : 1
    const offset = Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3, 5))
    stamp -= sign * offset * 60 * 1000
  }
  return stamp
}

export function parseXmltv(xml: string, now = Date.now()): EpgData {
  const channels: Record<string, string> = {}
  const programmes: Record<string, EpgProgramme[]> = {}
  const from = now - PAST_WINDOW
  const to = now + FUTURE_WINDOW

  CHANNEL_RE.lastIndex = 0
  let channelMatch: RegExpExecArray | null
  while ((channelMatch = CHANNEL_RE.exec(xml)) !== null) {
    const attrs = attrsOf(channelMatch[1])
    const id = attrs['id']
    if (!id) continue
    channels[id] = tagText(channelMatch[2], 'display-name') || id
  }

  let count = 0
  PROGRAMME_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = PROGRAMME_RE.exec(xml)) !== null) {
    if (count >= MAX_PROGRAMMES) break

    const attrs = attrsOf(match[1])
    const channel = attrs['channel']
    if (!channel) continue

    const start = parseXmltvTime(attrs['start'] ?? '')
    if (!start) continue
    let stop = parseXmltvTime(attrs['stop'] ?? '')
    if (!stop || stop <= start) stop = start + 30 * 60 * 1000

    if (stop < from || start > to) continue

    const body = match[2]
    const entry: EpgProgramme = {
      title: tagText(body, 'title') || '未命名节目',
      desc: tagText(body, 'desc'),
      category: tagText(body, 'category'),
      start,
      stop
    }
    if (!programmes[channel]) programmes[channel] = []
    programmes[channel].push(entry)
    if (!channels[channel]) channels[channel] = channel
    count++
  }

  for (const key of Object.keys(programmes)) {
    programmes[key].sort((a, b) => a.start - b.start)
  }

  return { channels, programmes }
}

/** 找出当前正在播出的节目 */
export function currentProgramme(list: EpgProgramme[] | undefined, now = Date.now()): EpgProgramme | null {
  if (!list || !list.length) return null
  for (const item of list) {
    if (item.start <= now && item.stop > now) return item
  }
  return null
}

/** 找出下一个待播节目 */
export function nextProgramme(list: EpgProgramme[] | undefined, now = Date.now()): EpgProgramme | null {
  if (!list || !list.length) return null
  for (const item of list) {
    if (item.start > now) return item
  }
  return null
}

/**
 * 把 M3U 频道的 tvg-id / tvg-name / 频道名映射到 EPG 的 channel id。
 * 不同站点命名不统一，这里做三级回退。
 */
export function matchEpgChannel(
  epg: EpgData | null,
  hints: { tvgId?: string; tvgName?: string; name?: string }
): string {
  if (!epg) return ''
  const { tvgId, tvgName, name } = hints
  if (tvgId && epg.programmes[tvgId]) return tvgId

  const candidates = [tvgId, tvgName, name].filter((value): value is string => Boolean(value))
  if (!candidates.length) return ''

  const keys = Object.keys(epg.programmes)
  for (const candidate of candidates) {
    const exact = keys.find((key) => key === candidate)
    if (exact) return exact
  }
  for (const candidate of candidates) {
    const lower = candidate.toLowerCase()
    const loose = keys.find((key) => key.toLowerCase() === lower)
    if (loose) return loose
    const display = Object.keys(epg.channels).find(
      (key) => (epg.channels[key] ?? '').toLowerCase() === lower
    )
    if (display) return display
  }
  return ''
}
