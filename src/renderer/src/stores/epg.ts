import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  currentProgramme,
  matchEpgChannel,
  nextProgramme,
  type EpgData,
  type EpgProgramme
} from '../../../shared/xmltv'
import { cacheDropPrefix, cacheGet, cacheSet } from '@renderer/utils/cache'
import { useSettingsStore } from './settings'

/** 节目单的新鲜期：这段时间内直接命中缓存，不再下载几十 MB 的 XMLTV */
const FRESH_MS = 60 * 60 * 1000
/** 彻底丢弃的时限（缓存优先策略下，旧节目单仍有参考价值） */
const HARD_MS = 7 * 24 * 60 * 60 * 1000
/** 单份节目单的落库上限，超过就只留在内存，避免污染本地存储 */
const MAX_BYTES = 24 * 1024 * 1024
/** 节目切换的最小刷新粒度 */
const CLOCK_MS = 60 * 1000

/**
 * 电子节目单。
 *
 * 相比早期实现（只有 30 分钟的内存缓存，且每次视图挂载都重新拉一遍），
 * 这里做了三件事：
 *   1. 落库到 IndexedDB —— 重启应用也能秒开；
 *   2. 合并并发请求 —— 应用启动与直播页挂载不会再重复下载同一份；
 *   3. 缓存优先 + 后台静默换新 —— 界面不会因为刷新而闪一下。
 */
export const useEpgStore = defineStore('epg', () => {
  const settings = useSettingsStore()

  const data = ref<EpgData | null>(null)
  const loading = ref(false)
  const error = ref('')
  const loadedAt = ref(0)
  const programmeCount = ref(0)
  const channelCount = ref(0)
  /** 当前节目单来自缓存 */
  const fromCache = ref(false)
  /** 每分钟推进一次，驱动「正在播出」自动切换 */
  const now = ref(Date.now())

  const configured = computed(() => Boolean(settings.settings.epgUrl?.trim()))
  const ready = computed(() => data.value !== null)

  let clock: number | undefined
  let inFlight: Promise<void> | null = null
  /** 当前内存数据对应的地址，地址变了要作废旧数据 */
  let loadedUrl = ''

  function startClock(): void {
    if (clock !== undefined) return
    clock = window.setInterval(() => (now.value = Date.now()), CLOCK_MS)
  }

  function cacheKey(url: string): string {
    return `epg:${url}`
  }

  function countsOf(source: EpgData): { channels: number; programmes: number } {
    let programmes = 0
    for (const key of Object.keys(source.programmes)) programmes += source.programmes[key].length
    return { channels: Object.keys(source.channels).length, programmes }
  }

  /** 缓存里的节目单必须还有「未来」的内容，否则说明已经放完了，得重新下载 */
  function hasUpcoming(source: EpgData, at = Date.now()): boolean {
    for (const key of Object.keys(source.programmes)) {
      const list = source.programmes[key]
      if (list.length && list[list.length - 1].stop > at) return true
    }
    return false
  }

  function apply(source: EpgData, savedAt: number, cached: boolean, url: string): void {
    const counts = countsOf(source)
    data.value = source
    programmeCount.value = counts.programmes
    channelCount.value = counts.channels
    loadedAt.value = savedAt
    fromCache.value = cached
    loadedUrl = url
    startClock()
  }

  async function fetchRemote(url: string, silent: boolean): Promise<void> {
    if (!silent) loading.value = true
    try {
      const result = await window.api.epg.fetch(url)
      if (!result.ok || !result.data) {
        // 后台换新失败时保留屏幕上的旧节目单，不打扰用户
        if (!silent || !data.value) error.value = result.error || '节目单加载失败'
        return
      }

      apply(result.data, Date.now(), false, url)
      error.value = ''
      void cacheSet(cacheKey(url), 'epg', result.data, {
        fresh: FRESH_MS,
        hard: HARD_MS,
        maxBytes: MAX_BYTES
      })
    } catch (caught) {
      if (!silent || !data.value) {
        error.value = caught instanceof Error ? caught.message : '节目单加载失败'
      }
    } finally {
      if (!silent) loading.value = false
    }
  }

  async function run(url: string, force: boolean): Promise<void> {
    startClock()

    if (!force) {
      // 同一地址的内存命中，且未过新鲜期
      if (data.value && loadedUrl === url && Date.now() - loadedAt.value < FRESH_MS) return

      const hit = await cacheGet<EpgData>(cacheKey(url))
      if (hit && hasUpcoming(hit.value)) {
        apply(hit.value, hit.savedAt, true, url)
        error.value = ''
        // 先把节目单铺到界面上，再后台换新
        if (hit.stale) void fetchRemote(url, true)
        return
      }
    }

    await fetchRemote(url, false)
  }

  function load(force = false): Promise<void> {
    const url = settings.settings.epgUrl?.trim() ?? ''
    if (!url) {
      error.value = '未配置节目单地址'
      data.value = null
      loadedAt.value = 0
      loadedUrl = ''
      return Promise.resolve()
    }

    // 换了地址，内存里的旧节目单立刻作废
    if (data.value && loadedUrl !== url) {
      data.value = null
      loadedAt.value = 0
      fromCache.value = false
    }

    // 已经在下载了就复用，避免启动流程与直播页各拉一遍
    if (inFlight) return inFlight

    const task = run(url, force).finally(() => {
      if (inFlight === task) inFlight = null
    })
    inFlight = task
    return task
  }

  function channelIdOf(hints: { tvgId?: string; tvgName?: string; name?: string }): string {
    return matchEpgChannel(data.value, hints)
  }

  function nowAndNext(channelId: string): { current: EpgProgramme | null; next: EpgProgramme | null } {
    const list = channelId ? data.value?.programmes[channelId] : undefined
    return {
      current: currentProgramme(list, now.value),
      next: nextProgramme(list, now.value)
    }
  }

  function scheduleOf(channelId: string): EpgProgramme[] {
    return channelId ? data.value?.programmes[channelId] ?? [] : []
  }

  /** 清空节目单（地址被移除时调用，连同缓存一起删掉） */
  async function clear(): Promise<void> {
    data.value = null
    loadedAt.value = 0
    programmeCount.value = 0
    channelCount.value = 0
    error.value = ''
    fromCache.value = false
    if (loadedUrl) {
      await cacheDropPrefix(cacheKey(loadedUrl))
      loadedUrl = ''
    }
  }

  /** 内容缓存被清空后同步界面标记 */
  function onCacheCleared(): void {
    fromCache.value = false
  }

  return {
    data,
    loading,
    error,
    loadedAt,
    programmeCount,
    channelCount,
    fromCache,
    now,
    configured,
    ready,
    load,
    channelIdOf,
    nowAndNext,
    scheduleOf,
    clear,
    onCacheCleared
  }
})
