/**
 * 剧集归属与更新状态 —— 纯逻辑层。
 *
 * 两个用途：
 *  1. 「片头片尾」、观看进度都按**剧集**归组，而不是按单集地址 ——
 *     同一部剧换一集不该让用户重新设一遍片头。
 *  2. 「同步追剧」要判断一部剧有没有更新，只能从采集站的备注文字里读集数。
 */
import { vodKey } from './maccms'

/**
 * 采集剧集的 key 前缀。
 *
 * 加前缀是为了把「追剧条目」和「媒体库里的本地文件」分成两个 key 空间 ——
 * 本地文件用 `local:` 开头，两者永远不会撞车。
 */
export const SERIES_VOD_PREFIX = 'vod:'
export const SERIES_LOCAL_PREFIX = 'local:'

/** 采集剧集的归属 key；同一部剧的每一集共用同一个值 */
export function vodSeriesKey(sourceId: number, vodId: string): string {
  return `${SERIES_VOD_PREFIX}${vodKey(sourceId, vodId)}`
}

/** 反解 `vodSeriesKey`；不是采集剧集时返回 `null` */
export function parseVodSeriesKey(key: string): { sourceId: number; vodId: string } | null {
  if (!key.startsWith(SERIES_VOD_PREFIX)) return null
  const rest = key.slice(SERIES_VOD_PREFIX.length)
  const at = rest.indexOf(':')
  if (at <= 0 || at === rest.length - 1) return null
  const sourceId = Number(rest.slice(0, at))
  const vodId = rest.slice(at + 1)
  if (!Number.isInteger(sourceId) || !vodId) return null
  return { sourceId, vodId }
}

/** 本地文件的归属 key（同一目录的剧集不合并，各自一份配置） */
export function localSeriesKey(src: string): string {
  return `${SERIES_LOCAL_PREFIX}${src}`
}

/**
 * 从采集站的备注文字里抠出集数。
 *
 * 真实站点写法很杂，实测见过：`更新至14集`、`更新至第06集`、`全24集`、`12集全`、
 * `已完结`、`HD`、`BD`、`正片`，也有直接写数字的。所以先找「数字 + 集」，
 * 再退化成「整个字符串就是数字」，其余一律 0（表示未知，不能拿它判更新）。
 */
export function parseEpisodeCount(text: string | undefined | null): number {
  if (!text) return 0
  const withUnit = /(\d+)\s*集/.exec(text)
  if (withUnit) return Number(withUnit[1])
  const bare = /^\s*(\d+)\s*$/.exec(text)
  return bare ? Number(bare[1]) : 0
}

/**
 * 同步后是否出现了新集。
 *
 * 两端都必须「已知」才算数：
 *  - `after` 未知（0）：采集站漏了备注，无从判断；
 *  - `before` 未知（0）：上次根本不知道有多少集，这次知道了只是「信息补全」，
 *    不是「更新」。把未知当成 0 会让第一次同步就在每部剧上亮小红点，
 *    那个标记很快就会没人当回事。
 * 两端都已知之后（`episodeCount` 会被同步写回），后续的 12 → 14 就能正常报出来。
 */
export function hasNewEpisodes(before: number, after: number): boolean {
  const base = Number.isFinite(before) ? before : 0
  if (!Number.isFinite(after) || after <= 0) return false
  return base > 0 && after > base
}
