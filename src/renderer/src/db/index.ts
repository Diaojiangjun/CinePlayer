import Dexie, { type Table } from 'dexie'
import type {
  AppSettings,
  CacheEntry,
  CollectionItem,
  FavoriteItem,
  HistoryRecord,
  MediaItem,
  SkipProfileRecord,
  StreamChannel,
  StreamSource
} from './types'

export class CineDatabase extends Dexie {
  media!: Table<MediaItem, number>
  history!: Table<HistoryRecord, number>
  favorite!: Table<FavoriteItem, number>
  sources!: Table<StreamSource, number>
  channels!: Table<StreamChannel, number>
  collections!: Table<CollectionItem, number>
  settings!: Table<AppSettings, number>
  apiCache!: Table<CacheEntry, string>
  skip!: Table<SkipProfileRecord, string>

  constructor() {
    super('cineplayer')
    this.version(1).stores({
      media: '++id, &path, title, name, folder, addedAt',
      history: '++id, &path, playedAt',
      favorite: '++id, &path, kind, addedAt',
      sources: '++id, name, kind, isActive, addedAt',
      channels: '++id, sourceId, name, group, index',
      settings: 'id'
    })

    // v2：新增采集影片收藏表。sources 表新增的 autoRefresh / classes 等字段
    // 不参与索引，Dexie 允许直接写入，无需重建表。
    this.version(2).stores({
      collections: '++id, &key, sourceId, vodId, addedAt'
    })

    // v3：远程内容缓存（采集列表 / 影片详情 / 节目单）。
    // 每次升级只需声明新增或变更的表，已有表会被自动继承。
    this.version(3).stores({
      apiCache: '&key, scope, freshUntil, expiresAt, savedAt'
    })

    // v4：跳过片头片尾的配置，按剧集归属 key 存一份。
    // collections 新增的同步 / 观看进度字段都不是索引，Dexie 允许直接写入，无需重建表。
    this.version(4).stores({
      skip: '&key, updatedAt'
    })
  }
}

export const db = new CineDatabase()

export const DEFAULT_SETTINGS: AppSettings = {
  id: 1,
  theme: 'dark',
  libraryView: 'poster',
  volume: 1,
  playbackRate: 1,
  rememberProgress: true,
  resumeThreshold: 5,
  autoplayNext: true,
  scanFolders: [],
  epgUrl: '',
  contentCacheMinutes: 60
}

// 首次打开数据库时写入默认设置
db.on('populate', () => {
  db.settings.add({ ...DEFAULT_SETTINGS })
})

export async function ensureSettings(): Promise<AppSettings> {
  const existing = await db.settings.get(1)
  if (!existing) {
    await db.settings.put({ ...DEFAULT_SETTINGS })
    return { ...DEFAULT_SETTINGS }
  }

  // 老版本记录补齐后续新增的字段，避免读取到 undefined
  const merged: AppSettings = { ...DEFAULT_SETTINGS, ...existing, id: 1 }
  const missing = (Object.keys(DEFAULT_SETTINGS) as (keyof AppSettings)[]).some(
    (key) => existing[key] === undefined
  )
  if (missing) await db.settings.put(merged)
  return merged
}
