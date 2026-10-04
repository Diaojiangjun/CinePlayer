import type { MacClass } from '../../../shared/maccms'

export interface MediaItem {
  id?: number
  path: string
  name: string
  title: string
  ext: string
  size: number
  mtime: number
  folder: string
  cover?: string
  duration?: number
  addedAt: number
}

export interface HistoryRecord {
  id?: number
  path: string
  title: string
  cover?: string
  position: number
  duration: number
  playedAt: number
}

export interface FavoriteItem {
  id?: number
  path: string
  title: string
  cover?: string
  kind: 'local' | 'stream'
  addedAt: number
}

/** 内容源类型：本地 M3U 文件 / 远程 M3U 订阅 / 单条流地址 / 苹果CMS 采集接口 */
export type SourceKind = 'm3u' | 'single' | 'maccms'

export interface StreamSource {
  id?: number
  name: string
  /** m3u 源为订阅地址，single 为流地址，maccms 为接口根地址 */
  url: string
  kind: SourceKind
  isActive: boolean
  builtin?: boolean
  /** 远程订阅是否在启动时自动刷新 */
  autoRefresh?: boolean
  /** 最近一次刷新时间 */
  updatedAt?: number
  /** maccms 源缓存的分类树 */
  classes?: MacClass[]
  addedAt: number
}

export interface StreamChannel {
  id?: number
  sourceId: number
  name: string
  url: string
  logo?: string
  group?: string
  /** EPG 匹配用 */
  tvgId?: string
  tvgName?: string
  index: number
}

/** 采集来的影片收藏（追剧），播放地址实时向采集站请求，不入库 */
export interface CollectionItem {
  id?: number
  /** `${sourceId}:${vodId}`，保证同一影片只收藏一次 */
  key: string
  sourceId: number
  vodId: string
  name: string
  pic?: string
  /** 最近一次已知的更新备注（收藏时来自列表，同步时来自详情） */
  note?: string
  typeName?: string
  addedAt: number

  /* --- 同步追剧：以下字段都不参与索引，所以新增时无需升 Dexie 版本 --- */

  /** 最近一次同步拿到的集数，用来算下一轮有没有新集 */
  episodeCount?: number
  /** 有新集且用户还没点开看过 */
  newEpisodes?: boolean
  /** 最近一次同步成功的时间 */
  syncedAt?: number
  /** 最近一次同步失败的原因；成功后清空 */
  syncError?: string

  /* --- 观看进度：看到第几集 --- */

  /** 看到第几集（剧集列表里的 0 基下标） */
  watchedIndex?: number
  /** 看到的那一集名字，如「第3集」 */
  watchedName?: string
  watchedAt?: number
}

/**
 * 跳过片头片尾的配置。
 *
 * 按**剧集**归组（`vod:<sourceId>:<vodId>`），所以同一部剧换一集不用重设；
 * 本地文件各自一份（`local:<路径>`）。
 */
export interface SkipProfileRecord {
  /** 归属 key，主键 */
  key: string
  /** 片头结束点（秒）；0 = 未设置 */
  introEnd: number
  /** 片尾开始点（秒）；0 = 未设置 */
  outroStart: number
  /** 进入片头区间即自动跳过 */
  autoIntro: boolean
  /** 进入片尾区间即自动续播下一集 */
  autoOutro: boolean
  updatedAt: number
}

export interface AppSettings {
  id: number
  theme: 'dark' | 'light'
  libraryView: 'poster' | 'list'
  volume: number
  playbackRate: number
  rememberProgress: boolean
  resumeThreshold: number
  autoplayNext: boolean
  scanFolders: string[]
  /** XMLTV 节目单地址（http/https，支持 .xml 与 .xml.gz） */
  epgUrl: string
  /** 内容缓存新鲜期（分钟）；0 表示关闭缓存，每次请求都走网络 */
  contentCacheMinutes: number
}

/** 内容缓存的分类，便于按类型统计与清理 */
export type CacheScope = 'collect-list' | 'collect-detail' | 'epg'

/**
 * 远程内容的本地缓存条目。
 *
 * `freshUntil` 之前是「新鲜」的，直接命中不产生任何网络请求；
 * 过了 `freshUntil` 但未到 `expiresAt` 时先渲染缓存、后台静默刷新；
 * 超过 `expiresAt` 视为失效，重新请求。
 */
export interface CacheEntry<T = unknown> {
  key: string
  scope: CacheScope
  value: T
  savedAt: number
  freshUntil: number
  expiresAt: number
  /** 估算占用字节数 */
  size: number
  /** 1 表示体积估算被截断（仅统计了前若干个节点），实际占用只会更大 */
  partial: number
}
