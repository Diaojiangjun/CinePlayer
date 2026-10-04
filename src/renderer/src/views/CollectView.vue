<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useCollectStore } from '@renderer/stores/collect'
import { useSourcesStore } from '@renderer/stores/sources'
import { formatRelative } from '@renderer/utils/format'
import { dropBrokenPoster, posterGradient } from '@renderer/utils/poster'
import type { MacVod } from '../../../shared/maccms'
import type { CollectionItem } from '@renderer/db/types'

const router = useRouter()
const collect = useCollectStore()
const sources = useSourcesStore()

const message = ref('')
const tab = ref<'browse' | 'starred'>('browse')

const addName = ref('')
const addUrl = ref('')
const adding = ref(false)
const searchText = ref('')

const message2 = ref('')
let flashTimer: number | undefined

function flash(text: string): void {
  message.value = text
  window.clearTimeout(flashTimer)
  flashTimer = window.setTimeout(() => (message.value = ''), 3000)
}

const hasSources = computed(() => collect.maccmsSources.length > 0)

/* ------------------------------ 采集源管理 ------------------------------ */

async function addSource(): Promise<void> {
  if (!addUrl.value.trim()) {
    flash('请填写采集接口地址')
    return
  }
  adding.value = true
  try {
    const id = await sources.addMaccmsSource(addName.value, addUrl.value)
    collect.selectSource(id)
    await collect.browse('', 1)
    addName.value = ''
    addUrl.value = ''
    flash('采集源已添加')
  } catch (error) {
    flash(error instanceof Error ? error.message : '添加失败')
  } finally {
    adding.value = false
  }
}

async function removeSource(id: number, name: string): Promise<void> {
  if (!window.confirm(`确定删除采集源「${name}」吗？`)) return
  await sources.removeSource(id)
  await collect.invalidateSourceData(id)
  collect.ensureActive()
  collect.selectSource(collect.activeSource?.id ?? 0)
  if (collect.maccmsSources.length) await collect.browse('', 1)
  else collect.vods = []
  flash('已删除采集源')
}

async function switchSource(event: Event): Promise<void> {
  const id = Number((event.target as HTMLSelectElement).value)
  if (!Number.isFinite(id)) return
  collect.selectSource(id)
  await collect.browse('', 1)
}

async function refreshSource(): Promise<void> {
  const id = collect.activeSource?.id
  if (id === undefined) return
  try {
    await sources.refreshSource(id)
    // 分类变了，该源缓存的列表/详情一并作废，避免显示旧分类下的内容
    await collect.invalidateSourceData(id)
    await collect.browse('', 1, { force: true })
    flash('分类已更新')
  } catch (error) {
    flash(error instanceof Error ? error.message : '刷新失败')
  }
}

async function refreshList(): Promise<void> {
  await collect.refreshList()
  flash(collect.error ? `刷新失败：${collect.error}` : '已重新拉取列表')
}

/** 缓存状态提示：正在后台换新 / 当前显示的是缓存 */
const cacheHint = computed(() => {
  if (collect.revalidating) return '正在更新…'
  if (!collect.fromCache || !collect.lastSyncAt) return ''
  return `缓存 · ${formatRelative(collect.lastSyncAt)}`
})

/* -------------------------------- 浏览 -------------------------------- */

async function pickClass(typeId: string): Promise<void> {
  await collect.browse(typeId, 1)
}

async function doSearch(): Promise<void> {
  await collect.search(searchText.value, 1)
}

async function goPage(delta: number): Promise<void> {
  const target = collect.page + delta
  if (target < 1 || target > collect.pageCount) return
  if (collect.mode === 'search') await collect.search(collect.keyword, target)
  else await collect.browse(collect.activeTypeId, target)
}

function openDetail(vod: MacVod): void {
  router.push({
    name: 'collect-detail',
    query: { id: vod.vodId, source: String(collect.activeSource?.id ?? '') }
  })
}

/* -------------------------------- 追剧 -------------------------------- */

const starred = computed(() => collect.collections)

async function removeStar(id: number): Promise<void> {
  await collect.removeCollection(id)
  flash('已取消收藏')
}

/** 打开一部追剧的详情页 */
function openStar(item: CollectionItem): void {
  router.push({ name: 'collect-detail', query: { id: item.vodId, source: String(item.sourceId) } })
}

/**
 * 「继续观看」：带着看到第几集的下标进详情页，那边会自动起播。
 *
 * 不直接跳播放页，是因为播放页需要整条线路的选集列表 ——
 * 那个列表只有详情页拿得到（详情接口才知道整条线路有哪些集）。
 */
function continueWatching(item: CollectionItem): void {
  const index = item.watchedIndex ?? 0
  router.push({
    name: 'collect-detail',
    query: { id: item.vodId, source: String(item.sourceId), ep: String(index) }
  })
}

/** 「继续观看」按钮上的文字：看过就回到那一集，没看过就从第一集开始 */
function resumeLabel(item: CollectionItem): string {
  const index = item.watchedIndex
  if (index === undefined || index === null || index < 0) return '从第1集开始'
  return `继续看 ${item.watchedName || `第${index + 1}集`}`
}

function resumeTitle(item: CollectionItem): string {
  const index = item.watchedIndex
  if (index === undefined || index === null || index < 0) return '还没有观看记录'
  return `上次看到 ${item.watchedName || `第${index + 1}集`}`
}

/** 卡片第二行：分类 + 同步时间（失败时换成失败提示） */
function starMeta(item: CollectionItem): string {
  const parts: string[] = []
  if (item.typeName) parts.push(item.typeName)
  if (item.syncError) parts.push('同步失败')
  else if (item.syncedAt) parts.push(`同步于 ${formatRelative(item.syncedAt)}`)
  else parts.push(formatRelative(item.addedAt))
  return parts.join(' · ')
}

/* ------------------------------ 同步追剧 ------------------------------ */

const syncLabel = computed(() => {
  const state = collect.syncState
  return state.running ? `同步中 ${state.done}/${state.total}` : '同步追剧'
})

/** 工具栏上的补充说明：最近一次同步 / 有几部在看 */
const followHint = computed(() => {
  const list = starred.value
  if (!list.length) return ''
  const synced = list
    .map((item) => item.syncedAt ?? 0)
    .filter((value) => value > 0)
    .sort((a, b) => b - a)[0]
  const fresh = list.filter((item) => item.newEpisodes === true).length
  const parts: string[] = []
  if (fresh) parts.push(`${fresh} 部有新集`)
  parts.push(synced ? `上次同步 ${formatRelative(synced)}` : '尚未同步过')
  return ` · ${parts.join(' · ')}`
})

async function syncAll(): Promise<void> {
  await collect.syncCollections()
  flash(collect.syncState.message || '同步完成')
}

onMounted(async () => {
  await sources.load()
  await collect.loadCollections()
  // 命中缓存会立即渲染；没有缓存才真正请求，来回切页不会重置浏览位置
  await collect.ensureInitial()
})
</script>

<template>
  <div class="collect">
    <header class="view-header">
      <div>
        <h2 class="view-title">影视点播</h2>
        <span class="view-subtitle">通过苹果CMS采集接口浏览、搜索并播放</span>
      </div>
      <div class="collect__spacer"></div>

      <div v-if="collect.maccmsSources.length" class="collect__switch">
        <select class="input" :value="collect.activeSource?.id" @change="switchSource">
          <option v-for="source in collect.maccmsSources" :key="source.id" :value="source.id">
            {{ source.name }}
          </option>
        </select>
        <button class="btn btn--ghost" title="刷新分类" @click="refreshSource">
          <svg viewBox="0 0 24 24" width="15" height="15">
            <path
              d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
        <button
          class="icon-btn icon-btn--danger"
          title="删除该采集源"
          @click="
            collect.activeSource?.id !== undefined &&
              removeSource(collect.activeSource!.id!, collect.activeSource!.name)
          "
        >
          <svg viewBox="0 0 24 24" width="15" height="15">
            <path
              d="M6 7h12M9 7V5h6v2m-7 0v12h8V7"
              fill="none"
              stroke="currentColor"
              stroke-width="1.7"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
      </div>

      <div class="segmented">
        <button :class="{ active: tab === 'browse' }" @click="tab = 'browse'">浏览</button>
        <button :class="{ active: tab === 'starred' }" @click="tab = 'starred'">
          我的追剧（{{ starred.length }}）
        </button>
      </div>
    </header>

    <div v-if="message || message2" class="collect__toast">{{ message || message2 }}</div>

    <!-- 还没有采集源：直接给接入表单 -->
    <div v-if="!hasSources" class="collect__setup scroll-area">
      <section class="panel setup">
        <h3 class="setup__title">添加苹果CMS采集接口</h3>
        <p class="setup__desc">
          填入采集站点的接口根地址即可，例如 <code>https://example.com</code> 或
          <code>https://example.com/api.php/provide/vod/</code>。应用会自动补全接口路径并读取分类。
        </p>

        <div class="setup__form">
          <input v-model="addName" class="input" placeholder="名称（可留空，默认用域名）" />
          <input
            v-model="addUrl"
            class="input setup__url"
            placeholder="https://example.com/api.php/provide/vod/"
            @keyup.enter="addSource"
          />
          <button class="btn btn--primary" :disabled="adding" @click="addSource">
            {{ adding ? '校验接口…' : '添加' }}
          </button>
        </div>

        <p class="setup__hint">
          采集内容由对应站点提供，请确认你拥有访问与观看的合法授权。
        </p>
      </section>
    </div>

    <div v-else class="collect__body">
      <aside class="collect__side scroll-area">
        <section class="panel">
          <h3 class="panel__title">添加采集源</h3>
          <input v-model="addName" class="input" placeholder="名称（可留空）" />
          <input
            v-model="addUrl"
            class="input"
            placeholder="https://example.com/api.php/provide/vod/"
            @keyup.enter="addSource"
          />
          <button class="btn" :disabled="adding" @click="addSource">
            {{ adding ? '校验接口…' : '添加采集源' }}
          </button>
        </section>

        <section v-if="tab === 'browse'" class="panel">
          <h3 class="panel__title">分类</h3>

          <p v-if="!collect.treeClasses.length" class="panel__empty">该接口没有返回分类</p>

          <ul v-else class="cat-list">
            <li>
              <button
                class="cat"
                :class="{ 'cat--active': collect.mode === 'list' && !collect.activeTypeId }"
                @click="pickClass('')"
              >
                全部
              </button>
            </li>
            <li v-for="item in collect.treeClasses" :key="item.id">
              <button
                class="cat"
                :class="{ 'cat--active': collect.mode === 'list' && collect.activeTypeId === item.id }"
                :style="{ paddingLeft: 10 + item.depth * 12 + 'px' }"
                @click="pickClass(item.id)"
              >
                {{ item.name }}
              </button>
            </li>
          </ul>
        </section>
      </aside>

      <main class="collect__main">
        <template v-if="tab === 'browse'">
          <div class="collect__toolbar">
            <input
              v-model="searchText"
              class="input collect__search"
              placeholder="搜索片名，回车开始搜索…"
              @keyup.enter="doSearch"
            />
            <button class="btn" @click="doSearch">搜索</button>
            <div class="collect__spacer"></div>
            <span v-if="cacheHint" class="collect__cache">{{ cacheHint }}</span>
            <span v-if="collect.total" class="view-subtitle">
              共 {{ collect.total }} 条 · 第 {{ collect.page }} / {{ collect.pageCount }} 页
            </span>
            <button
              class="icon-btn"
              title="重新拉取列表（跳过缓存）"
              :disabled="collect.loading"
              @click="refreshList"
            >
              <svg viewBox="0 0 24 24" width="15" height="15">
                <path
                  d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.8"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </button>
          </div>

          <!-- 父分类没有直属影片时的一次性说明：单独占一行，免得把工具栏挤爆 -->
          <p v-if="collect.notice" class="collect__notice">{{ collect.notice }}</p>

          <p v-if="collect.loading && !collect.vods.length" class="panel__empty collect__empty">
            正在加载…
          </p>
          <p v-else-if="collect.error" class="collect__error">{{ collect.error }}</p>
          <p v-else-if="!collect.vods.length" class="panel__empty collect__empty">
            {{ collect.mode === 'search' ? '没有搜索到相关影片' : '该分类下暂无内容' }}
          </p>

          <div v-else class="grid scroll-area">
            <button v-for="vod in collect.vods" :key="vod.vodId" class="card" @click="openDetail(vod)">
              <span class="card__poster" :style="vod.pic ? undefined : posterGradient(vod.name)">
                <img v-if="vod.pic" :src="vod.pic" alt="" loading="lazy" @error="dropBrokenPoster(vod)" />
                <span v-else class="card__initial">{{ vod.name.charAt(0) }}</span>
                <span v-if="vod.note" class="card__note">{{ vod.note }}</span>
              </span>
              <span class="card__name">{{ vod.name }}</span>
              <span class="card__meta">
                {{ [vod.year, vod.area, vod.typeName].filter(Boolean).join(' · ') || '—' }}
              </span>
            </button>
          </div>

          <div v-if="collect.pageCount > 1 && !collect.loading" class="pager">
            <button class="btn" :disabled="collect.page <= 1" @click="goPage(-1)">上一页</button>
            <span class="pager__label">{{ collect.page }} / {{ collect.pageCount }}</span>
            <button class="btn" :disabled="collect.page >= collect.pageCount" @click="goPage(1)">
              下一页
            </button>
          </div>
        </template>

        <template v-else>
          <div class="collect__toolbar">
            <span v-if="starred.length" class="view-subtitle">
              {{ starred.length }} 部追剧{{ followHint }}
            </span>
            <div class="collect__spacer"></div>
            <button
              class="btn"
              :disabled="collect.syncState.running || !starred.length"
              title="重新拉取每部追剧的最新集数"
              @click="syncAll"
            >
              <svg viewBox="0 0 24 24" width="15" height="15">
                <path
                  d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.8"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
              {{ syncLabel }}
            </button>
          </div>

          <p v-if="!starred.length" class="panel__empty collect__empty">
            还没有收藏的影片，浏览时在详情页点「追剧」即可。
          </p>

          <div v-else class="grid scroll-area">
            <div v-for="item in starred" :key="item.id" class="card card--static">
              <button class="card__hit" @click="openStar(item)">
                <span class="card__poster" :style="item.pic ? undefined : posterGradient(item.name)">
                  <img v-if="item.pic" :src="item.pic" alt="" loading="lazy" @error="dropBrokenPoster(item)" />
                  <span v-else class="card__initial">{{ item.name.charAt(0) }}</span>
                  <span v-if="item.note" class="card__note">{{ item.note }}</span>
                  <span v-if="item.newEpisodes" class="card__new">有新集</span>
                </span>
                <span class="card__name">{{ item.name }}</span>
                <span class="card__meta" :title="item.syncError || ''">{{ starMeta(item) }}</span>
              </button>

              <button class="card__resume" :title="resumeTitle(item)" @click="continueWatching(item)">
                {{ resumeLabel(item) }}
              </button>

              <button class="card__remove" title="取消收藏" @click="removeStar(item.id!)">移除</button>
            </div>
          </div>
        </template>
      </main>
    </div>
  </div>
</template>

<style scoped>
.collect {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.collect__spacer {
  flex: 1;
}

.collect__switch {
  display: flex;
  align-items: center;
  gap: 6px;
}

.collect__switch .input {
  min-width: 180px;
  max-width: 240px;
}

.collect__toast {
  margin: 0 24px 6px;
  padding: 8px 14px;
  border-radius: 8px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 13px;
}

.segmented {
  display: inline-flex;
  padding: 3px;
  border-radius: 9px;
  background: var(--surface-2);
  gap: 2px;
}

.segmented button {
  height: 28px;
  padding: 0 12px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--text-muted);
  font-size: 12.5px;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}

.segmented button.active {
  background: var(--accent);
  color: #fff;
}

.collect__setup {
  flex: 1;
  padding: 4px 24px 24px;
}

.panel {
  padding: 14px;
  border-radius: 12px;
  background: var(--surface);
  border: 1px solid var(--border);
}

.panel__title {
  font-size: 13.5px;
  margin-bottom: 10px;
}

.panel__empty {
  margin: 0;
  font-size: 13px;
  color: var(--text-muted);
}

.setup {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-width: 760px;
}

.setup__title {
  font-size: 15px;
}

.setup__desc {
  margin: 0;
  font-size: 13px;
  color: var(--text-muted);
  line-height: 1.8;
}

.setup__desc code {
  padding: 1px 5px;
  border-radius: 5px;
  background: var(--surface-2);
  font-size: 12px;
}

.setup__form {
  display: flex;
  gap: 10px;
}

.setup__form .input {
  flex: 1;
}

.setup__form .setup__url {
  flex: 2;
}

.setup__hint {
  margin: 0;
  font-size: 12px;
  color: var(--text-faint);
}

.collect__body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 240px minmax(0, 1fr);
  gap: 16px;
  padding: 4px 24px 20px;
}

.collect__side {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding-right: 4px;
}

.collect__side .panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.collect__main {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.collect__toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
}

.collect__search {
  width: 260px;
}

.collect__cache {
  font-size: 12px;
  color: var(--text-faint);
  white-space: nowrap;
}

/* 父分类没有直属影片时的一次性说明，用完即消失 */
.collect__notice {
  margin: 0 0 4px;
  padding: 6px 10px;
  border-radius: 6px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 12px;
  line-height: 1.5;
}

.collect__empty {
  padding: 28px 0;
  text-align: center;
}

.collect__error {
  margin: 0;
  padding: 12px 14px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--danger) 12%, transparent);
  color: var(--danger);
  font-size: 13px;
}

.cat-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 46vh;
  overflow-y: auto;
}

.cat {
  width: 100%;
  height: 30px;
  padding: 0 10px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--text-muted);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: background 0.15s ease, color 0.15s ease;
}

.cat:hover {
  background: var(--surface-2);
  color: var(--text);
}

.cat--active {
  background: var(--accent-soft);
  color: var(--accent);
}

.grid {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(148px, 1fr));
  gap: 14px;
  align-content: start;
  padding-right: 4px;
}

.card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--text);
  text-align: left;
  cursor: pointer;
  /* 关键：网格项默认 `min-width: auto`，会被下面 nowrap 的标题撑破 ——
     卡片因此宽于自己的轨道，把相邻卡片的标题直接压在一起。
     置 0 后标题只能在自己的列里换行/截断。 */
  min-width: 0;
}

.card__hit {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  padding: 0;
  border: none;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}

.card__poster {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  aspect-ratio: 2 / 3;
  border-radius: 10px;
  overflow: hidden;
  background: var(--surface-2);
  border: 1px solid var(--border);
  transition: transform 0.18s ease, border-color 0.18s ease;
}

.card:hover .card__poster {
  transform: translateY(-2px);
  border-color: var(--accent);
}

.card__poster img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.card__initial {
  font-size: 32px;
  color: rgba(255, 255, 255, 0.86);
}

.card__note {
  position: absolute;
  left: 6px;
  bottom: 6px;
  max-width: calc(100% - 12px);
  padding: 2px 6px;
  border-radius: 5px;
  background: rgba(0, 0, 0, 0.62);
  color: #fff;
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 「有新集」角标：追剧列表里一眼看出哪部该追了 */
.card__new {
  position: absolute;
  top: 6px;
  left: 6px;
  padding: 2px 7px;
  border-radius: 5px;
  background: #ff4d5e;
  color: #fff;
  font-size: 11px;
  line-height: 1.5;
  box-shadow: 0 2px 8px rgba(255, 77, 94, 0.38);
}

/* 「继续观看」：从上次看到的那一集接着放 */
.card__resume {
  margin-top: 2px;
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--surface-2);
  color: var(--text-muted);
  font-size: 11.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
  transition: border-color 0.15s ease, color 0.15s ease, background 0.15s ease;
}

.card__resume:hover {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}

/* 片名过长时**换行**（最多两行），而不是挤成一团 */
.card__name {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  font-size: 13px;
  line-height: 1.4;
  word-break: break-word;
  /* 固定两行高度：一行片名与两行片名并排时，底部信息仍能对齐 */
  min-height: 2.8em;
}

.card__meta {
  font-size: 11.5px;
  color: var(--text-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.card--static {
  position: relative;
}

.card__remove {
  position: absolute;
  top: 6px;
  right: 6px;
  height: 22px;
  padding: 0 8px;
  border: none;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.6);
  color: #fff;
  font-size: 11px;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s ease;
}

.card--static:hover .card__remove {
  opacity: 1;
}

.pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  flex-shrink: 0;
}

.pager__label {
  font-size: 13px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}

.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: none;
  border-radius: 8px;
  background: var(--surface-2);
  color: var(--text-muted);
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}

.icon-btn:hover {
  background: var(--surface-3);
  color: var(--text);
}

.icon-btn--danger:hover {
  color: var(--danger);
}
</style>
