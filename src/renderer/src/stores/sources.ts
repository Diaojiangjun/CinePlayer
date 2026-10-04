import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { db } from '@renderer/db'
import type { SourceKind, StreamChannel, StreamSource } from '@renderer/db/types'
import { groupStats, parseM3U, type IptvChannel } from '../../../shared/iptv'
import { normalizeApiUrl } from '../../../shared/maccms'

/** 频道量级常达上万条，分批写入避免单次事务过大 */
const CHUNK_SIZE = 5000
/** 远程订阅超过这个时长未刷新，启动时自动更新 */
const STALE_MS = 6 * 60 * 60 * 1000

function hostOf(raw: string): string {
  const value = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
  try {
    return new URL(value).host
  } catch {
    return raw
  }
}

export const useSourcesStore = defineStore('sources', () => {
  const sources = ref<StreamSource[]>([])
  const channels = ref<StreamChannel[]>([])
  const activeSourceId = ref<number | null>(null)
  /** 正在刷新（拉取订阅）的源 id */
  const refreshingId = ref<number | null>(null)

  /**
   * 「本会话是否已经读过」标记。
   *
   * 早期实现里每个视图挂载都会 load() 一次，而 load() 会把 sources 与
   * channels 整表读进内存 —— 频道上万条时，来回切页就是反复做无谓的全表扫描。
   * 现在视图层的 load() 只在本会话第一次真正读库，写操作则直接调用 refresh*。
   */
  let sourcesLoaded = false
  let channelsLoaded = false
  let sourcesPending: Promise<void> | null = null
  let channelsPending: Promise<void> | null = null

  const activeSource = computed(
    () => sources.value.find((s) => s.id === activeSourceId.value) ?? null
  )

  const activeChannels = computed(() =>
    channels.value.filter((c) => c.sourceId === activeSourceId.value)
  )

  const groups = computed(() => groupStats(activeChannels.value))

  const maccmsSources = computed(() => sources.value.filter((s) => s.kind === 'maccms'))

  /** 远程订阅源（可直接刷新） */
  const remoteSources = computed(() =>
    sources.value.filter((s) => s.kind === 'm3u' && /^https?:\/\//i.test(s.url))
  )

  /* --------------------------- 读取与失效 --------------------------- */

  async function refreshSources(): Promise<void> {
    sources.value = await db.sources.orderBy('addedAt').toArray()

    const stillValid =
      activeSourceId.value !== null && sources.value.some((s) => s.id === activeSourceId.value)
    if (!stillValid) {
      const active =
        sources.value.find((s) => s.isActive && s.kind !== 'maccms') ??
        sources.value.find((s) => s.kind !== 'maccms')
      activeSourceId.value = active?.id ?? null
    }
  }

  /** 频道只在被视图请求过之后才需要在内存里保持同步 */
  async function refreshChannels(): Promise<void> {
    if (!channelsLoaded) return
    channels.value = await db.channels.orderBy('index').toArray()
  }

  /** 视图挂载时调用；一个会话内只会真正读库一次 */
  async function load(): Promise<void> {
    if (sourcesLoaded) return
    if (sourcesPending) return sourcesPending
    sourcesPending = (async () => {
      try {
        await refreshSources()
        sourcesLoaded = true
      } finally {
        sourcesPending = null
      }
    })()
    return sourcesPending
  }

  /** 直播页专用：频道列表较大，只有真的要看直播时才读 */
  async function loadChannels(): Promise<void> {
    if (channelsLoaded) return
    if (channelsPending) return channelsPending
    channelsPending = (async () => {
      try {
        channels.value = await db.channels.orderBy('index').toArray()
        channelsLoaded = true
      } finally {
        channelsPending = null
      }
    })()
    return channelsPending
  }

  /* ------------------------------ 写入 ------------------------------ */

  /** 覆盖式写入频道列表；先删后插，保证刷新后不残留失效频道 */
  async function replaceChannels(sourceId: number, parsed: IptvChannel[]): Promise<void> {
    await db.channels.where('sourceId').equals(sourceId).delete()

    const rows: StreamChannel[] = parsed.map((channel, index) => ({
      sourceId,
      name: channel.name,
      url: channel.url,
      logo: channel.logo,
      group: channel.group,
      tvgId: channel.tvgId,
      tvgName: channel.tvgName,
      index
    }))

    for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
      await db.channels.bulkAdd(rows.slice(i, i + CHUNK_SIZE))
    }

    // 写完之后让内存副本跟上（未被加载过时 refreshChannels 会自动跳过）
    await refreshChannels()
  }

  async function addM3uContent(
    name: string,
    content: string,
    originUrl = '',
    kind: SourceKind = 'm3u',
    autoRefresh = false
  ): Promise<number> {
    const parsed = parseM3U(content)
    if (!parsed.length) throw new Error('播放列表里没有解析到任何频道')

    // 所有 IPC / 文件读取都必须发生在 Dexie 事务之外，否则事务会被提前提交
    const sourceId = (await db.sources.add({
      name: name || 'M3U 源',
      url: originUrl,
      kind,
      isActive: sources.value.filter((s) => s.kind !== 'maccms').length === 0,
      autoRefresh,
      updatedAt: Date.now(),
      addedAt: Date.now()
    })) as number

    await replaceChannels(sourceId, parsed)
    await refreshSources()
    return sourceId
  }

  async function importM3uFile(): Promise<number | null> {
    const filePath = await window.api.dialog.openPlaylist()
    if (!filePath) return null
    const content = await window.api.fs.readText(filePath)
    const baseName = (filePath.split(/[\\/]/).pop() ?? 'M3U 源').replace(/\.(m3u8?|txt)$/i, '')
    return addM3uContent(baseName, content, filePath)
  }

  /** 远程 M3U 订阅：拉取内容后入库，并标记为可自动刷新 */
  async function addM3uUrl(name: string, url: string): Promise<number> {
    const target = url.trim()
    if (!target) throw new Error('请填写订阅地址')

    refreshingId.value = null
    const response = await window.api.live.fetchPlaylist(target)
    if (!response.ok) throw new Error(response.error || '订阅拉取失败')

    return addM3uContent(name.trim() || hostOf(target), response.content, target, 'm3u', true)
  }

  async function addSingle(name: string, url: string): Promise<number> {
    const sourceId = (await db.sources.add({
      name: name || url,
      url,
      kind: 'single',
      isActive: sources.value.filter((s) => s.kind !== 'maccms').length === 0,
      updatedAt: Date.now(),
      addedAt: Date.now()
    })) as number
    await refreshSources()
    return sourceId
  }

  /** 添加苹果CMS采集源：先探测接口，拿到分类树再入库 */
  async function addMaccmsSource(name: string, apiUrl: string): Promise<number> {
    const target = apiUrl.trim()
    if (!target) throw new Error('请填写采集接口地址')

    const result = await window.api.collect.test(target)
    if (!result.ok) throw new Error(result.error || '采集接口不可用')

    const sourceId = (await db.sources.add({
      name: name.trim() || hostOf(target),
      url: normalizeApiUrl(target),
      kind: 'maccms',
      isActive: false,
      classes: result.data?.classes ?? [],
      updatedAt: Date.now(),
      addedAt: Date.now()
    })) as number

    await refreshSources()
    return sourceId
  }

  /**
   * 刷新单个源：采集源更新分类，远程订阅重新拉取频道。
   * `skipReload` 用于批量刷新场景，避免每个源都整表重读一次。
   */
  async function refreshSource(id: number, options: { skipReload?: boolean } = {}): Promise<number> {
    const source = sources.value.find((s) => s.id === id)
    if (!source) return 0

    if (source.kind === 'maccms') {
      const result = await window.api.collect.test(source.url)
      if (!result.ok) throw new Error(result.error || '刷新失败')
      await db.sources.update(id, {
        classes: result.data?.classes ?? [],
        updatedAt: Date.now()
      })
      if (!options.skipReload) await refreshSources()
      return result.data?.classes.length ?? 0
    }

    if (source.kind === 'm3u' && /^https?:\/\//i.test(source.url)) {
      refreshingId.value = id
      try {
        const response = await window.api.live.fetchPlaylist(source.url)
        if (!response.ok) throw new Error(response.error || '订阅拉取失败')
        const parsed = parseM3U(response.content)
        if (!parsed.length) throw new Error('订阅内容里没有频道')
        await replaceChannels(id, parsed)
        await db.sources.update(id, { updatedAt: Date.now() })
        if (!options.skipReload) await refreshSources()
        return parsed.length
      } finally {
        refreshingId.value = null
      }
    }

    return 0
  }

  /** 启动时静默刷新过期订阅，失败不影响其它源 */
  async function refreshStale(): Promise<void> {
    const stale = sources.value.filter(
      (s) =>
        s.kind === 'm3u' &&
        s.autoRefresh &&
        /^https?:\/\//i.test(s.url) &&
        s.id !== undefined &&
        Date.now() - (s.updatedAt ?? 0) > STALE_MS
    )
    if (!stale.length) return

    for (const source of stale) {
      try {
        await refreshSource(source.id as number, { skipReload: true })
      } catch {
        /* 单个源失败时跳过 */
      }
    }

    // 批量刷新结束后统一同步一次内存，而不是每个源各读一遍
    await refreshSources()
  }

  async function removeSource(id: number): Promise<void> {
    await db.transaction('rw', db.sources, db.channels, async () => {
      await db.sources.delete(id)
      await db.channels.where('sourceId').equals(id).delete()
    })
    if (activeSourceId.value === id) activeSourceId.value = null
    await refreshSources()
    await refreshChannels()
  }

  async function setActive(id: number): Promise<void> {
    await db.transaction('rw', db.sources, async () => {
      for (const source of sources.value) {
        if (source.id !== undefined) await db.sources.update(source.id, { isActive: source.id === id })
      }
    })
    activeSourceId.value = id
    await refreshSources()
  }

  /** 手动指定当前浏览的源（不写库，仅切换视图） */
  function setViewing(id: number | null): void {
    activeSourceId.value = id
  }

  function channelsOf(sourceId: number | null): StreamChannel[] {
    if (sourceId === null) return []
    return channels.value.filter((c) => c.sourceId === sourceId)
  }

  return {
    sources,
    channels,
    activeSourceId,
    refreshingId,
    activeSource,
    activeChannels,
    groups,
    maccmsSources,
    remoteSources,
    load,
    loadChannels,
    refreshSources,
    refreshChannels,
    addM3uContent,
    importM3uFile,
    addM3uUrl,
    addSingle,
    addMaccmsSource,
    refreshSource,
    refreshStale,
    removeSource,
    setActive,
    setViewing,
    channelsOf
  }
})
