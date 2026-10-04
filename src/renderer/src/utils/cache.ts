import { db } from '@renderer/db'
import type { CacheEntry, CacheScope } from '@renderer/db/types'

/**
 * 远程内容的统一缓存入口。
 *
 * 分三层：
 *   1. 内存层（Map）—— 视图来回切换时零成本命中，避免连 IndexedDB 都不必读；
 *   2. 持久层（IndexedDB）—— 关掉应用再打开依然命中，这是「不再每次重新加载」的关键；
 *   3. 网络层 —— 只在没有可用缓存、缓存已彻底过期或用户手动刷新时才会走。
 *
 * 「过期」不等于「不可用」：过了新鲜期但仍在有效期内的条目会被标成 stale，
 * 调用方可以先拿它渲染，再在后台静默重新拉取（stale-while-revalidate），
 * 这样界面既即时又不会一直停在旧数据上。
 */

/** 内存层最多保留的条目数，超出后按写入顺序淘汰 */
const MEMORY_LIMIT = 80
/** 体积估算最多遍历的节点数，防止对超大节目单做全量遍历 */
const SIZE_NODE_BUDGET = 6000
/** 默认硬过期倍率：新鲜期的多少倍之后彻底丢弃 */
const HARD_FACTOR = 6

const memory = new Map<string, CacheEntry>()

function remember(entry: CacheEntry): void {
  memory.delete(entry.key)
  memory.set(entry.key, entry)
  while (memory.size > MEMORY_LIMIT) {
    const oldest = memory.keys().next().value
    if (oldest === undefined) break
    memory.delete(oldest)
  }
}

/**
 * 估算一条缓存的体积。节目单动辄几十万条节目，全量 JSON.stringify 会卡住渲染线程，
 * 所以这里做「有预算的遍历」：遍历够 N 个节点就停下并标记为 partial（下界）。
 */
function estimateBytes(root: unknown): { size: number; partial: number } {
  let size = 0
  let nodes = 0
  let partial = 0
  const stack: unknown[] = [root]

  while (stack.length) {
    if (nodes >= SIZE_NODE_BUDGET) {
      partial = 1
      break
    }
    const value = stack.pop()
    nodes++

    if (typeof value === 'string') {
      size += value.length * 2 + 8
      continue
    }
    if (typeof value === 'number') {
      size += 8
      continue
    }
    if (typeof value === 'boolean') {
      size += 4
      continue
    }
    if (!value || typeof value !== 'object') continue

    if (Array.isArray(value)) {
      size += 32
      for (let i = value.length - 1; i >= 0; i--) {
        if (stack.length >= SIZE_NODE_BUDGET) {
          partial = 1
          break
        }
        stack.push(value[i])
      }
      continue
    }

    size += 48
    const record = value as Record<string, unknown>
    for (const key of Object.keys(record)) {
      if (stack.length >= SIZE_NODE_BUDGET) {
        partial = 1
        break
      }
      size += key.length * 2 + 8
      stack.push(record[key])
    }
  }

  return { size, partial }
}

export interface CacheHit<T> {
  value: T
  /** 写入缓存的时间 */
  savedAt: number
  /** true 表示已过新鲜期，建议先展示再后台刷新 */
  stale: boolean
}

export interface CacheWriteOptions {
  /** 新鲜期（毫秒）；此时间内直接命中，不产生任何请求 */
  fresh: number
  /** 超过此时间彻底丢弃，默认新鲜期的 6 倍 */
  hard?: number
  /** 单条体积上限（字节）。超出时只留在内存层，不落库 */
  maxBytes?: number
}

/** 只查内存层，同步返回，用于「同一会话内秒开」 */
export function cachePeek<T>(key: string): CacheHit<T> | null {
  const entry = memory.get(key)
  if (!entry) return null
  const now = Date.now()
  if (entry.expiresAt <= now) {
    memory.delete(key)
    return null
  }
  return { value: entry.value as T, savedAt: entry.savedAt, stale: entry.freshUntil <= now }
}

/** 先内存后 IndexedDB；返回 null 表示没有可用缓存 */
export async function cacheGet<T>(key: string): Promise<CacheHit<T> | null> {
  const quick = cachePeek<T>(key)
  if (quick) return quick

  let entry: CacheEntry | undefined
  try {
    entry = await db.apiCache.get(key)
  } catch {
    return null
  }
  if (!entry) return null

  const now = Date.now()
  if (entry.expiresAt <= now) {
    void db.apiCache.delete(key).catch(() => undefined)
    return null
  }

  remember(entry)
  return { value: entry.value as T, savedAt: entry.savedAt, stale: entry.freshUntil <= now }
}

/**
 * 写入缓存。返回 false 表示体积超过上限，只留在内存层（节目单可能是几十 MB，
 * 落库会拖慢主线程且很快撑爆配额）。
 */
export async function cacheSet<T>(
  key: string,
  scope: CacheScope,
  value: T,
  options: CacheWriteOptions
): Promise<boolean> {
  const { fresh, hard = fresh * HARD_FACTOR, maxBytes } = options
  const now = Date.now()
  const { size, partial } = estimateBytes(value)

  const entry: CacheEntry<T> = {
    key,
    scope,
    value,
    savedAt: now,
    freshUntil: now + fresh,
    expiresAt: now + hard,
    size,
    partial
  }
  remember(entry as CacheEntry)

  // 体积超过上限时只留在内存层（partial 表示 size 只是下界，同样按超限处理）
  if (maxBytes !== undefined && size > maxBytes) return false

  try {
    await db.apiCache.put(entry as CacheEntry)
    return true
  } catch {
    // 配额不足等异常不影响主流程：内存层仍然可用
    return false
  }
}

/** 按 key 前缀失效，例如某个采集源的全部列表 */
export async function cacheDropPrefix(prefix: string): Promise<number> {
  for (const key of [...memory.keys()]) {
    if (key.startsWith(prefix)) memory.delete(key)
  }
  try {
    return await db.apiCache.where('key').startsWith(prefix).delete()
  } catch {
    return 0
  }
}

export async function cacheDropScope(scope: CacheScope): Promise<number> {
  for (const [key, entry] of [...memory.entries()]) {
    if (entry.scope === scope) memory.delete(key)
  }
  try {
    return await db.apiCache.where('scope').equals(scope).delete()
  } catch {
    return 0
  }
}

/** 清空全部内容缓存 */
export async function cacheClear(): Promise<void> {
  memory.clear()
  try {
    await db.apiCache.clear()
  } catch {
    /* 清空失败不影响主流程 */
  }
}

/** 清理已彻底过期的条目；启动时跑一次即可 */
export async function cachePrune(now = Date.now()): Promise<number> {
  for (const [key, entry] of [...memory.entries()]) {
    if (entry.expiresAt <= now) memory.delete(key)
  }
  try {
    return await db.apiCache.where('expiresAt').belowOrEqual(now).delete()
  } catch {
    return 0
  }
}

export interface CacheStats {
  list: number
  detail: number
  epg: number
  total: number
  /** 估算占用（字节） */
  bytes: number
  /** true 表示有部分条目体积估算被截断，实际占用更大 */
  approximate: boolean
  /** 最近一次写入时间，0 表示空 */
  latest: number
}

/** 统计缓存概况。会逐条读取记录，只在设置页按需调用 */
export async function cacheStats(): Promise<CacheStats> {
  const stats: CacheStats = {
    list: 0,
    detail: 0,
    epg: 0,
    total: 0,
    bytes: 0,
    approximate: false,
    latest: 0
  }

  try {
    await db.apiCache.each((entry) => {
      stats.total++
      if (entry.scope === 'collect-list') stats.list++
      else if (entry.scope === 'collect-detail') stats.detail++
      else stats.epg++
      stats.bytes += entry.size
      if (entry.partial) stats.approximate = true
      if (entry.savedAt > stats.latest) stats.latest = entry.savedAt
    })
  } catch {
    /* 读取失败时返回空统计 */
  }

  return stats
}
