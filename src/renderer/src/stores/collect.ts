import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { db } from '@renderer/db'
import type { CollectionItem, StreamSource } from '@renderer/db/types'
import type { MacClass, MacListResult, MacVod } from '../../../shared/maccms'
import { vodKey } from '../../../shared/maccms'
import { hasNewEpisodes, parseEpisodeCount } from '../../../shared/series'
import { cacheDropPrefix, cacheGet, cacheSet } from '@renderer/utils/cache'
import { useSettingsStore } from './settings'
import { useSourcesStore } from './sources'

const PAGE_SIZE_HINT = 20

/** 列表缓存的最短保鲜下限，避免用户把有效期调得很短时频繁回源 */
const LIST_HARD_MIN = 12 * 60 * 60 * 1000
/** 详情缓存的最短保鲜下限；剧集更新不会太频繁 */
const DETAIL_HARD_MIN = 24 * 60 * 60 * 1000
const HARD_MAX = 14 * 24 * 60 * 60 * 1000

interface ListQuery {
  typeId: string
  keyword: string
  page: number
}

interface RunOptions {
  /** 忽略缓存，强制回源 */
  force?: boolean
  /** 后台静默刷新：不显示 loading、失败不覆盖界面 */
  silent?: boolean
}

/** 「同步追剧」的进度快照 */
interface SyncState {
  running: boolean
  /** 已同步 / 总数，用来显示 N/M */
  done: number
  total: number
  /** 本轮发现更新的部数 */
  updated: number
  /** 本轮失败的部数 */
  failed: number
  /** 结束后的结果说明 */
  message: string
}

/**
 * 苹果CMS 采集源的浏览状态。
 *
 * 数据策略是「缓存优先 + 后台静默刷新」：
 *   - 命中缓存立即渲染，不出现 loading 闪烁，也不会重复请求；
 *   - 缓存过期时先把旧内容留在屏幕上，后台拉新数据再替换；
 *   - 只有用户主动点刷新、或缓存彻底失效时才回源。
 * 缓存落在 IndexedDB，因此「关掉应用再打开」同样是秒开。
 */
export const useCollectStore = defineStore('collect', () => {
  const sources = useSourcesStore()
  const settings = useSettingsStore()

  const activeSourceId = ref<number | null>(null)
  const classes = ref<MacClass[]>([])
  const vods = ref<MacVod[]>([])
  const loading = ref(false)
  const error = ref('')
  /** 当前这份数据来自缓存（而非本次网络请求） */
  const fromCache = ref(false)
  /** 当前这份数据的写入/获取时间 */
  const lastSyncAt = ref(0)
  /** 正在后台静默刷新（界面仍显示旧数据） */
  const revalidating = ref(false)
  /** 需要向用户说明的一次性提示（如「父分类没有内容，已自动切到子分类」） */
  const notice = ref('')

  const keyword = ref('')
  const activeTypeId = ref('')
  const mode = ref<'list' | 'search'>('list')
  const page = ref(1)
  const pageCount = ref(1)
  const total = ref(0)

  const collections = ref<CollectionItem[]>([])
  /** 最近一次打开的详情，供详情页秒开 */
  const lastVod = ref<MacVod | null>(null)
  const lastVodId = ref('')
  const lastVodSourceId = ref<number | null>(null)
  const detailLoading = ref(false)
  const detailError = ref('')
  const detailFromCache = ref(false)
  const detailSyncAt = ref(0)

  /**
   * 最近一次「发起」的列表请求对应的缓存 key。
   *
   * 注意这里必须是「请求」而不是「屏幕上正在显示的」：切换分类首次进入时缓存必然未命中，
   * 若拿屏幕上的 key 去比对，新分类的响应会被当成迟到数据丢掉 ——
   * 表现就是「点了分类，高亮变了但内容没变」。用请求侧的 key 才既能丢掉真的迟到响应，
   * 又不会误伤刚切过去的这一次。
   */
  let requestedKey = ''
  /** 同一份数据的并发请求合并，避免多个入口同时触发时打两次接口 */
  const listInflight = new Map<string, Promise<void>>()
  const detailInflight = new Map<string, Promise<MacVod | null>>()
  /** 已经尝试过补封面的列表 key：同一份数据只补一次，避免反复请求 */
  const posterTried = new Set<string>()

  const maccmsSources = computed(() => sources.sources.filter((s) => s.kind === 'maccms'))

  const activeSource = computed<StreamSource | null>(
    () => maccmsSources.value.find((s) => s.id === activeSourceId.value) ?? maccmsSources.value[0] ?? null
  )

  const apiUrl = computed(() => activeSource.value?.url ?? '')

  const displayClasses = computed<MacClass[]>(() => {
    if (classes.value.length) return classes.value
    return activeSource.value?.classes ?? []
  })

  const collectedKeys = computed(() => new Set(collections.value.map((item) => item.key)))

  /** 用户设置的新鲜期（毫秒），0 表示关闭缓存 */
  function freshMs(): number {
    const minutes = settings.settings.contentCacheMinutes ?? 0
    return minutes > 0 ? minutes * 60_000 : 0
  }

  function listHardMs(fresh: number): number {
    return Math.min(Math.max(fresh * 6, LIST_HARD_MIN), HARD_MAX)
  }

  function detailHardMs(fresh: number): number {
    return Math.min(Math.max(fresh * 12, DETAIL_HARD_MIN), HARD_MAX)
  }

  function listKey(url: string, query: ListQuery): string {
    const id = activeSource.value?.id ?? -1
    return `collect-list:${id}:${url}:${query.typeId}:${query.keyword}:${query.page}`
  }

  function detailKey(url: string, sourceId: number | null, vodId: string): string {
    return `collect-detail:${sourceId ?? -1}:${url}:${vodId}`
  }

  function ensureActive(): void {
    if (activeSourceId.value !== null && maccmsSources.value.some((s) => s.id === activeSourceId.value)) {
      return
    }
    activeSourceId.value = maccmsSources.value[0]?.id ?? null
  }

  function selectSource(id: number): void {
    activeSourceId.value = id
    classes.value = []
    vods.value = []
    keyword.value = ''
    activeTypeId.value = ''
    mode.value = 'list'
    page.value = 1
    pageCount.value = 1
    total.value = 0
    error.value = ''
    fromCache.value = false
    lastSyncAt.value = 0
    notice.value = ''
    requestedKey = ''
    posterTried.clear()
  }

  /** 分类节点常带子分类（连续剧 → 国产剧/欧美剧…），拍平后展示 */
  function flattenClasses(list: MacClass[]): { id: string; name: string; depth: number }[] {
    const byParent = new Map<string, MacClass[]>()
    for (const item of list) {
      const parent = item.pid && item.pid !== '0' ? item.pid : '0'
      if (!byParent.has(parent)) byParent.set(parent, [])
      byParent.get(parent)!.push(item)
    }

    const result: { id: string; name: string; depth: number }[] = []
    const walk = (parent: string, depth: number): void => {
      for (const item of byParent.get(parent) ?? []) {
        result.push({ id: item.id, name: item.name, depth })
        if (depth < 2) walk(item.id, depth + 1)
      }
    }
    walk('0', 0)
    return result
  }

  const treeClasses = computed(() => flattenClasses(displayClasses.value))

  /**
   * 取某个分类的第一个子分类。
   *
   * 为什么需要它：苹果CMS 站点的分类表里，`type_pid=0` 的**父分类只是个分组标题**，
   * 服务端按父 id 过滤（`t=1`）经常返回 0 条 —— 实测某采集站的
   * 「电影片」就是 `total=0`，而子分类「动作片」有几千条。
   * 用户点了父分类看到一片空白，就会认为「点击分类没效果」。
   */
  function firstChildOf(typeId: string): MacClass | null {
    if (!typeId) return null
    return displayClasses.value.find((item) => item.pid === typeId) ?? null
  }

  async function persistClasses(list: MacClass[]): Promise<void> {
    if (!list.length) return
    const id = activeSource.value?.id
    if (id === undefined) return
    classes.value = list
    try {
      await db.sources.update(id, { classes: list })
    } catch {
      /* 缓存分类失败不影响浏览 */
    }
  }

  /* ------------------------------ 列表 ------------------------------ */

  function applyList(key: string, data: MacListResult, savedAt: number): void {
    requestedKey = key
    vods.value = data.vods
    page.value = Math.max(1, data.page)
    pageCount.value = Math.max(1, data.pageCount)
    total.value = data.total
    lastSyncAt.value = savedAt
  }

  /* ---------------------------- 封面补全 ---------------------------- */

  /** 列表接口（ac=list）多数站点不返回封面，缺了就补 */
  function needsPosters(data: MacListResult): boolean {
    return data.vods.some((vod) => !vod.pic && !!vod.vodId)
  }

  /**
   * 新拉到的列表若没有封面，沿用屏幕上同一部影片已有的封面。
   * 否则「后台静默换新」会把已经显示出来的海报又擦掉、再补回来，视觉上闪一下。
   * 按 vodId 精确匹配，跨分类的同一部影片本来就共用封面，不会串。
   */
  function inheritPosters(data: MacListResult): void {
    if (!vods.value.length) return
    const known = new Map<string, string>()
    for (const vod of vods.value) if (vod.pic) known.set(vod.vodId, vod.pic)
    if (!known.size) return
    for (const vod of data.vods) {
      if (!vod.pic) {
        const pic = known.get(vod.vodId)
        if (pic) vod.pic = pic
      }
    }
  }

  /** 把一批「id → 封面」填进给定列表，返回填上的条数 */
  function fillPosters(list: MacVod[], byId: Map<string, string>): number {
    let filled = 0
    for (const vod of list) {
      if (vod.pic) continue
      const pic = byId.get(vod.vodId)
      if (!pic) continue
      vod.pic = pic
      filled++
    }
    return filled
  }

  /**
   * 后台批量补封面，并把结果并回同一份缓存。
   *
   * 不再逐个影片开请求：一次 `ac=detail&ids=a,b,c…` 就能拿回整页封面。
   * 补完立刻重写缓存，于是「第一次进分类补一次、以后（含重启应用）都直接命中带封面的版本」。
   * 站点不支持该用法时不会报错，只是封面留空，且同一份数据不会反复重试。
   */
  async function backfillPosters(
    url: string,
    key: string,
    data: MacListResult,
    fresh: number
  ): Promise<void> {
    if (posterTried.has(key) || !needsPosters(data)) return
    posterTried.add(key)

    const ids = data.vods.filter((vod) => !vod.pic && vod.vodId).map((vod) => vod.vodId)
    const result = await window.api.collect.pics(url, ids).catch(() => null)
    if (!result?.ok || !result.data?.length) return

    const byId = new Map(result.data.map((item) => [item.vodId, item.pic]))
    const before = data.vods.filter((vod) => !vod.pic).length

    // 必须**先**写 `vods.value`：那才是响应式代理，直接改原始对象不会触发视图更新。
    // 两者底层常常是同一批对象，先写屏幕这份，再补一次原始那份（用于未显示的数据 / 缓存）。
    fillPosters(vods.value, byId)
    fillPosters(data.vods, byId)

    const filled = before - data.vods.filter((vod) => !vod.pic).length
    // 封面并回缓存：下次命中就已经带封面，不必再补
    if (filled > 0 && fresh > 0) {
      void cacheSet(key, 'collect-list', data, { fresh, hard: listHardMs(fresh) })
    }
  }

  function fetchList(
    url: string,
    query: ListQuery,
    key: string,
    fresh: number,
    silent: boolean
  ): Promise<void> {
    const running = listInflight.get(key)
    if (running) return running

    const task = doFetchList(url, query, key, fresh, silent).finally(() => {
      if (listInflight.get(key) === task) listInflight.delete(key)
    })
    listInflight.set(key, task)
    return task
  }

  async function doFetchList(
    url: string,
    query: ListQuery,
    key: string,
    fresh: number,
    silent: boolean
  ): Promise<void> {
    if (silent) revalidating.value = true
    else loading.value = true
    if (!silent) error.value = ''

    try {
      const result = await window.api.collect.list(url, {
        typeId: query.typeId || undefined,
        keyword: query.keyword || undefined,
        page: query.page
      })

      if (!result.ok || !result.data) {
        // 静默刷新失败时保留屏幕上的旧数据，不打扰用户
        if (!silent) {
          error.value = result.error || '获取列表失败'
          if (!vods.value.length) {
            pageCount.value = 1
            total.value = 0
          }
        }
        return
      }

      inheritPosters(result.data)

      if (fresh > 0) void cacheSet(key, 'collect-list', result.data, { fresh, hard: listHardMs(fresh) })
      if (result.data.classes.length) void persistClasses(result.data.classes)

      // 封面补全与「用户是否还停在这一页」无关：补完写进缓存，下次进来直接带封面
      if (needsPosters(result.data)) void backfillPosters(url, key, result.data, fresh)

      // 用户已经切到别的分类/页码，这份迟到数据只写缓存不动界面
      if (requestedKey !== key) return

      applyList(key, result.data, Date.now())
      fromCache.value = false
      error.value = ''
    } catch (caught) {
      if (!silent) {
        error.value = caught instanceof Error ? caught.message : '获取列表失败'
        if (!vods.value.length) vods.value = []
      }
    } finally {
      if (silent) revalidating.value = false
      else loading.value = false
    }
  }

  function revalidateList(url: string, query: ListQuery, key: string, fresh: number): void {
    if (revalidating.value) return
    void fetchList(url, query, key, fresh, true)
  }

  async function run(query: ListQuery, options: RunOptions = {}): Promise<void> {
    const url = apiUrl.value
    if (!url) {
      error.value = '还没有可用的采集源'
      vods.value = []
      return
    }

    const key = listKey(url, query)
    requestedKey = key
    const fresh = freshMs()

    if (!options.force && fresh > 0) {
      const hit = await cacheGet<MacListResult>(key)
      // 等缓存这段时间里用户已经切走，就别拿这份数据覆盖界面
      if (requestedKey !== key) return
      if (hit) {
        applyList(key, hit.value, hit.savedAt)
        fromCache.value = true
        error.value = ''
        if (hit.stale) {
          // 缓存不新鲜：先把内容留在屏幕上，再后台换新
          revalidateList(url, query, key, fresh)
        } else if (needsPosters(hit.value)) {
          // 这份缓存可能写于「封面补全」之前，顺手补一次
          void backfillPosters(url, key, hit.value, fresh)
        }
        return
      }
    }

    await fetchList(url, query, key, fresh, options.silent === true)
  }

  async function browse(
    typeId = '',
    targetPage = 1,
    options: RunOptions = {},
    depth = 0
  ): Promise<void> {
    mode.value = 'list'
    keyword.value = ''
    activeTypeId.value = typeId
    notice.value = ''
    await run({ typeId, keyword: '', page: targetPage }, options)

    // 父分类按 id 过滤返回空时，自动落到它的第一个子分类。
    // 只在「服务端明确说 0 条」时触发：请求出错、静默刷新、翻页都不能抢用户的浏览位置。
    if (depth >= 2 || options.silent === true || targetPage !== 1 || !typeId) return
    if (error.value || total.value > 0 || vods.value.length) return
    const child = firstChildOf(typeId)
    if (!child) return

    const parentName = displayClasses.value.find((item) => item.id === typeId)?.name ?? typeId
    // 递归进去会清空 notice，所以等它回来再写提示
    await browse(child.id, 1, options, depth + 1)
    notice.value = `「${parentName}」下没有直属影片，已切换到「${child.name}」`
  }

  async function search(text: string, targetPage = 1, options: RunOptions = {}): Promise<void> {
    const word = text.trim()
    if (!word) {
      await browse(activeTypeId.value, 1, options)
      return
    }
    mode.value = 'search'
    keyword.value = word
    activeTypeId.value = ''
    await run({ typeId: '', keyword: word, page: targetPage }, options)
  }

  /**
   * 视图挂载时调用：已经有内容就保持原样（必要时后台换新），
   * 没有内容才真正发起请求 —— 这样来回切页不会重置用户的浏览位置。
   */
  async function ensureInitial(): Promise<void> {
    ensureActive()
    if (!apiUrl.value) return
    if (loading.value) return

    if (!vods.value.length && mode.value !== 'search') {
      await browse(activeTypeId.value, page.value)
      return
    }
    await run({ typeId: activeTypeId.value, keyword: keyword.value, page: page.value })
  }

  /** 手动刷新当前列表（跳过缓存） */
  async function refreshList(): Promise<void> {
    // 手动刷新时允许重新尝试补封面（上次可能因网络抖动没补上）
    posterTried.clear()
    await run({ typeId: activeTypeId.value, keyword: keyword.value, page: page.value }, { force: true })
  }

  /** 某个采集源的数据整体失效（刷新分类 / 删除源时用） */
  async function invalidateSourceData(sourceId?: number): Promise<void> {
    const id = sourceId ?? activeSource.value?.id ?? -1
    posterTried.clear()
    await cacheDropPrefix(`collect-list:${id}:`)
    await cacheDropPrefix(`collect-detail:${id}:`)
  }

  /* ------------------------------ 详情 ------------------------------ */

  function setDetail(vod: MacVod, sourceId: number | null, savedAt: number): void {
    lastVod.value = vod
    lastVodId.value = vod.vodId
    lastVodSourceId.value = sourceId
    detailSyncAt.value = savedAt
  }

  function fetchDetail(
    url: string,
    sourceId: number | null,
    vodId: string,
    key: string,
    fresh: number,
    silent: boolean
  ): Promise<MacVod | null> {
    const running = detailInflight.get(key)
    if (running) return running

    const task = doFetchDetail(url, sourceId, vodId, key, fresh, silent).finally(() => {
      if (detailInflight.get(key) === task) detailInflight.delete(key)
    })
    detailInflight.set(key, task)
    return task
  }

  async function doFetchDetail(
    url: string,
    sourceId: number | null,
    vodId: string,
    key: string,
    fresh: number,
    silent: boolean
  ): Promise<MacVod | null> {
    if (silent) {
      /* 后台刷新不需要任何界面反馈 */
    } else {
      detailLoading.value = true
      detailError.value = ''
      // 先清掉上一部影片，避免加载中/失败时显示错的内容
      lastVod.value = null
      lastVodId.value = vodId
      lastVodSourceId.value = sourceId
    }

    try {
      const result = await window.api.collect.detail(url, vodId)
      if (!result.ok || !result.data?.vod) {
        if (!silent) detailError.value = result.error || '获取详情失败'
        return null
      }

      if (fresh > 0) {
        void cacheSet(key, 'collect-detail', result.data.vod, { fresh, hard: detailHardMs(fresh) })
      }

      // 静默刷新只更新「正在看的那一部」
      if (silent && (lastVodId.value !== vodId || lastVodSourceId.value !== sourceId)) return null

      setDetail(result.data.vod, sourceId, Date.now())
      detailFromCache.value = false
      return result.data.vod
    } catch (caught) {
      if (!silent) {
        detailError.value = caught instanceof Error ? caught.message : '获取详情失败'
      }
      return null
    } finally {
      if (!silent) detailLoading.value = false
    }
  }

  function revalidateDetail(
    url: string,
    sourceId: number | null,
    vodId: string,
    key: string,
    fresh: number
  ): void {
    void fetchDetail(url, sourceId, vodId, key, fresh, true)
  }

  async function open(vodId: string, options: RunOptions = {}): Promise<MacVod | null> {
    const url = apiUrl.value
    const sourceId = activeSource.value?.id ?? null
    if (!url || !vodId) {
      detailError.value = '采集源不可用'
      return null
    }

    const fresh = freshMs()
    const key = detailKey(url, sourceId, vodId)

    // 同一会话里再次打开同一部影片：内存里就有，直接给
    const memoryHit =
      lastVod.value !== null && lastVodId.value === vodId && lastVodSourceId.value === sourceId
    if (!options.force && memoryHit && lastVod.value) {
      detailFromCache.value = true
      detailError.value = ''
      if (fresh > 0 && Date.now() - detailSyncAt.value >= fresh) {
        revalidateDetail(url, sourceId, vodId, key, fresh)
      }
      return lastVod.value
    }

    if (!options.force && fresh > 0) {
      const hit = await cacheGet<MacVod>(key)
      if (hit) {
        setDetail(hit.value, sourceId, hit.savedAt)
        detailFromCache.value = true
        detailError.value = ''
        if (hit.stale) revalidateDetail(url, sourceId, vodId, key, fresh)
        return hit.value
      }
    }

    return fetchDetail(url, sourceId, vodId, key, fresh, options.silent === true)
  }

  /** 手动刷新当前详情（跳过缓存） */
  async function refreshDetail(): Promise<MacVod | null> {
    if (!lastVodId.value) return null
    return open(lastVodId.value, { force: true })
  }

  /** 缓存被清空后同步一下界面上的「来自缓存」标记 */
  function onCacheCleared(): void {
    fromCache.value = false
    detailFromCache.value = false
  }

  /* ----------------------------- 收藏 / 追剧 ----------------------------- */

  /** 追剧列表是否已经从库里读过一次 */
  let collectionsLoaded = false

  async function loadCollections(): Promise<void> {
    collections.value = await db.collections.orderBy('addedAt').reverse().toArray()
    collectionsLoaded = true
  }

  function isCollected(vodId: string): boolean {
    const id = activeSource.value?.id
    if (id === undefined) return false
    return collectedKeys.value.has(vodKey(id, vodId))
  }

  async function toggleCollection(vod: MacVod): Promise<boolean> {
    const sourceId = activeSource.value?.id
    if (sourceId === undefined || !vod.vodId) return false

    const key = vodKey(sourceId, vod.vodId)
    const existing = await db.collections.where('key').equals(key).first()
    if (existing?.id !== undefined) {
      await db.collections.delete(existing.id)
      await loadCollections()
      return false
    }

    await db.collections.add({
      key,
      sourceId,
      vodId: vod.vodId,
      name: vod.name,
      pic: vod.pic,
      note: vod.note,
      typeName: vod.typeName,
      // 收藏当刻的集数基线：没有它，「同步后有没有新集」就无从比较
      episodeCount: parseEpisodeCount(vod.note) || vod.serial || 0,
      addedAt: Date.now()
    })
    await loadCollections()
    return true
  }

  async function removeCollection(id: number): Promise<void> {
    await db.collections.delete(id)
    await loadCollections()
  }

  async function clearCollections(): Promise<void> {
    await db.collections.clear()
    await loadCollections()
  }

  /** 收藏项需要知道来自哪个采集源，才能拼出接口地址 */
  function sourceById(id: number): StreamSource | undefined {
    return sources.sources.find((s) => s.id === id)
  }

  /* ----------------------------- 同步追剧 ----------------------------- */

  const syncState = ref<SyncState>({
    running: false,
    done: 0,
    total: 0,
    updated: 0,
    failed: 0,
    message: ''
  })

  /** 只改这几个字段，其余保持原样。同时写内存与库，卡片角标才会立刻变 */
  async function patchCollection(item: CollectionItem, patch: Partial<CollectionItem>): Promise<void> {
    if (item.id === undefined) return
    try {
      await db.collections.update(item.id, patch)
    } catch (error) {
      console.warn('[collect] 更新追剧条目失败', error)
      return
    }
    const target = collections.value.find((row) => row.id === item.id)
    if (target) Object.assign(target, patch)
  }

  /**
   * 同步一部剧。
   *
   * 刻意**不走 `open()`**：那条路会写 `lastVod` / `detailLoading` 等浏览态，
   * 一次同步几十部会把用户当前的详情页搅乱。这里直接打 `collect:detail`，
   * 顺手把结果写进详情缓存 —— 之后点进去是秒开且已是最新。
   */
  async function syncOne(item: CollectionItem): Promise<'updated' | 'same' | 'failed'> {
    const url = sourceById(item.sourceId)?.url ?? ''
    if (!url) {
      await patchCollection(item, { syncError: '找不到对应的采集源' })
      return 'failed'
    }

    const result = await window.api.collect.detail(url, item.vodId).catch(() => null)
    if (!result?.ok || !result.data?.vod) {
      await patchCollection(item, { syncError: result?.error || '获取详情失败' })
      return 'failed'
    }

    const vod = result.data.vod
    // 集数只认「备注里的数字」，退而求其次用 serial。**不用 total**：
    // 连载中的剧 total 是全季集数（比如 24），拿它跟已更新的 14 比会一路误报「有新集」。
    const after = parseEpisodeCount(vod.note) || vod.serial || 0
    const before = item.episodeCount ?? parseEpisodeCount(item.note)
    const fresh = hasNewEpisodes(before, after)

    await patchCollection(item, {
      note: vod.note || item.note,
      episodeCount: after > 0 ? after : before,
      // 一旦标上了就不自动灭 —— 「有新集」要等用户真的点开详情才消
      newEpisodes: item.newEpisodes === true || fresh,
      syncedAt: Date.now(),
      syncError: ''
    })

    const freshMsValue = freshMs()
    if (freshMsValue > 0) {
      void cacheSet(detailKey(url, item.sourceId, item.vodId), 'collect-detail', vod, {
        fresh: freshMsValue,
        hard: detailHardMs(freshMsValue)
      })
    }

    return fresh ? 'updated' : 'same'
  }

  /**
   * 同步整个追剧列表。
   *
   * **串行**请求，不并发：这些请求打的是同一个采集站，几十个并发只会被对方限流，
   * 反而更容易失败。逐个来还能给出可靠的 N/M 进度。
   */
  async function syncCollections(): Promise<void> {
    if (syncState.value.running) return

    const list = collections.value.filter((item) => item.id !== undefined)
    if (!list.length) {
      syncState.value = {
        running: false,
        done: 0,
        total: 0,
        updated: 0,
        failed: 0,
        message: '还没有追剧'
      }
      return
    }

    syncState.value = { running: true, done: 0, total: list.length, updated: 0, failed: 0, message: '' }
    let updated = 0
    let failed = 0

    for (const item of list) {
      const outcome = await syncOne(item)
      if (outcome === 'updated') updated++
      if (outcome === 'failed') failed++
      syncState.value = { ...syncState.value, done: syncState.value.done + 1, updated, failed }
    }

    const parts = [`同步完成：${updated} 部有更新`]
    if (failed) parts.push(`${failed} 部失败`)
    syncState.value = {
      running: false,
      done: list.length,
      total: list.length,
      updated,
      failed,
      message: parts.join('，')
    }
    await loadCollections()
  }

  /**
   * 记下「这部追剧看到第几集」。
   *
   * 播放页每次切集都会调一次，只写内存与库，不发任何网络请求。
   */
  async function markWatched(
    sourceId: number,
    vodId: string,
    index: number,
    name: string
  ): Promise<void> {
    if (index < 0 || !vodId) return
    // 播放页可能先于影视点播页被打开（比如从「继续观看」直接进来），
    // 此时内存里还没有追剧列表 —— 先补读一次，否则这一笔进度会被静默丢掉。
    if (!collectionsLoaded) await loadCollections()
    const item = collections.value.find((row) => row.sourceId === sourceId && row.vodId === vodId)
    if (!item || item.id === undefined) return
    if (item.watchedIndex === index && item.watchedName === name) return
    await patchCollection(item, { watchedIndex: index, watchedName: name, watchedAt: Date.now() })
  }

  /** 用户点开了详情页 —— 消掉「有新集」标记 */
  async function markSeen(vodId: string): Promise<void> {
    if (!vodId || !collectionsLoaded) return
    const item = collections.value.find((row) => row.vodId === vodId && row.newEpisodes === true)
    if (!item) return
    await patchCollection(item, { newEpisodes: false })
  }

  /** 找出这部影片对应的追剧条目（「继续观看」据此拿到看到第几集） */
  function findCollection(sourceId: number, vodId: string): CollectionItem | null {
    if (!collectionsLoaded) return null
    return collections.value.find((row) => row.sourceId === sourceId && row.vodId === vodId) ?? null
  }

  return {
    syncState,
    syncCollections,
    markWatched,
    markSeen,
    findCollection,
    PAGE_SIZE_HINT,
    activeSourceId,
    notice,
    classes,
    treeClasses,
    displayClasses,
    vods,
    loading,
    error,
    fromCache,
    lastSyncAt,
    revalidating,
    keyword,
    activeTypeId,
    mode,
    page,
    pageCount,
    total,
    collections,
    lastVod,
    lastVodId,
    lastVodSourceId,
    detailLoading,
    detailError,
    detailFromCache,
    detailSyncAt,
    maccmsSources,
    activeSource,
    apiUrl,
    ensureActive,
    selectSource,
    browse,
    search,
    ensureInitial,
    refreshList,
    invalidateSourceData,
    open,
    refreshDetail,
    onCacheCleared,
    loadCollections,
    isCollected,
    toggleCollection,
    removeCollection,
    clearCollections,
    sourceById
  }
})
