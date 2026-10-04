<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useSourcesStore } from '@renderer/stores/sources'
import { useEpgStore } from '@renderer/stores/epg'
import { formatRelative } from '@renderer/utils/format'
import type { StreamChannel } from '@renderer/db/types'

const router = useRouter()
const sources = useSourcesStore()
const epg = useEpgStore()

/** 单页渲染上限，万级频道列表靠它保持流畅 */
const PAGE_SIZE = 200

const message = ref('')
const addMode = ref<'url' | 'single'>('url')
const formName = ref('')
const formUrl = ref('')
const busy = ref(false)

const keyword = ref('')
const activeGroup = ref('')
const limit = ref(PAGE_SIZE)

let flashTimer: number | undefined

function flash(text: string): void {
  message.value = text
  window.clearTimeout(flashTimer)
  flashTimer = window.setTimeout(() => (message.value = ''), 3000)
}

const activeChannels = computed(() => sources.activeChannels)

const filtered = computed(() => {
  const k = keyword.value.trim().toLowerCase()
  const group = activeGroup.value
  return activeChannels.value.filter((channel) => {
    if (group && (channel.group ?? '未分组') !== group) return false
    if (!k) return true
    return channel.name.toLowerCase().includes(k) || channel.url.toLowerCase().includes(k)
  })
})

const visible = computed(() => filtered.value.slice(0, limit.value))
const hasMore = computed(() => filtered.value.length > visible.value.length)

watch([keyword, activeGroup], () => (limit.value = PAGE_SIZE))
watch(() => sources.activeSourceId, () => {
  keyword.value = ''
  activeGroup.value = ''
  limit.value = PAGE_SIZE
})

const activeSource = computed(() => sources.activeSource)
const isSingle = computed(() => activeSource.value?.kind === 'single')

/* ------------------------------ 添加 / 刷新 ------------------------------ */

async function submitAdd(): Promise<void> {
  const url = formUrl.value.trim()
  if (!url) {
    flash('请填写地址')
    return
  }
  busy.value = true
  try {
    if (addMode.value === 'url') {
      const id = await sources.addM3uUrl(formName.value, url)
      const count = sources.channelsOf(id).length
      flash(`订阅已导入，共 ${count} 个频道`)
    } else {
      await sources.addSingle(formName.value.trim() || url, url)
      flash('已添加自定义流')
    }
    formName.value = ''
    formUrl.value = ''
  } catch (error) {
    flash(error instanceof Error ? error.message : '添加失败')
  } finally {
    busy.value = false
  }
}

async function importFile(): Promise<void> {
  busy.value = true
  try {
    const id = await sources.importM3uFile()
    if (id === null) return
    flash(`播放列表已导入，共 ${sources.channelsOf(id).length} 个频道`)
  } catch (error) {
    flash(error instanceof Error ? error.message : '导入失败')
  } finally {
    busy.value = false
  }
}

async function refresh(id: number): Promise<void> {
  try {
    const count = await sources.refreshSource(id)
    flash(count > 0 ? `已刷新，共 ${count} 个频道` : '该源无需刷新')
  } catch (error) {
    flash(error instanceof Error ? error.message : '刷新失败')
  }
}

async function remove(id: number, name: string): Promise<void> {
  if (!window.confirm(`确定删除内容源「${name}」吗？`)) return
  await sources.removeSource(id)
  flash('已删除内容源')
}

function playChannel(url: string, name: string): void {
  router.push({ name: 'play', query: { path: url, title: name } })
}

function sourceKindLabel(kind: string): string {
  if (kind === 'maccms') return '采集'
  if (kind === 'single') return '单流'
  return 'M3U'
}

/* -------------------------------- EPG -------------------------------- */

interface EpgLine {
  title: string
  time: string
  next: string
  nextTime: string
  percent: number
}

const EMPTY_EPG: EpgLine = { title: '', time: '', next: '', nextTime: '', percent: 0 }

function epgOf(channel: StreamChannel): EpgLine {
  if (!epg.ready) return EMPTY_EPG
  const id = epg.channelIdOf({ tvgId: channel.tvgId, tvgName: channel.tvgName, name: channel.name })
  if (!id) return EMPTY_EPG

  const { current, next } = epg.nowAndNext(id)
  const percent =
    current && current.stop > current.start
      ? Math.min(100, Math.round(((epg.now - current.start) / (current.stop - current.start)) * 100))
      : 0

  return {
    title: current?.title ?? '',
    time: current ? clock(current.start) : '',
    next: next?.title ?? '',
    nextTime: next ? clock(next.start) : '',
    percent: Math.max(0, percent)
  }
}

function clock(timestamp: number): string {
  const date = new Date(timestamp)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 频道与节目单一次合并，避免模板里对同一频道重复匹配 */
const rows = computed(() => visible.value.map((channel) => ({ channel, epg: epgOf(channel) })))

onMounted(async () => {
  await sources.load()
  // 频道列表可能有上万条，只有真的打开直播页才读进内存
  await sources.loadChannels()
  if (epg.configured) void epg.load()
})
</script>

<template>
  <div class="iptv">
    <header class="view-header">
      <div>
        <h2 class="view-title">电视直播</h2>
        <span class="view-subtitle">导入 M3U 播放列表或订阅地址，支持分组与节目单</span>
      </div>
      <div class="iptv__spacer"></div>
      <button class="btn" :disabled="busy" @click="importFile">
        <svg viewBox="0 0 24 24" width="16" height="16">
          <path
            d="M12 16V4m0 0L8 8m4-4l4 4M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        导入 M3U 文件
      </button>
    </header>

    <div v-if="message" class="iptv__toast">{{ message }}</div>

    <div class="iptv__body">
      <aside class="iptv__side scroll-area">
        <section class="panel">
          <h3 class="panel__title">添加内容源</h3>

          <div class="segmented">
            <button :class="{ active: addMode === 'url' }" @click="addMode = 'url'">M3U 订阅</button>
            <button :class="{ active: addMode === 'single' }" @click="addMode = 'single'">
              单条流
            </button>
          </div>

          <input v-model="formName" class="input" placeholder="名称（可留空）" />
          <input
            v-model="formUrl"
            class="input"
            :placeholder="addMode === 'url' ? 'https://example.com/playlist.m3u' : 'https://example.com/live.m3u8'"
            @keyup.enter="submitAdd"
          />
          <button class="btn btn--primary" :disabled="busy" @click="submitAdd">
            {{ busy ? '处理中…' : '添加' }}
          </button>
        </section>

        <section class="panel">
          <h3 class="panel__title">内容源（{{ sources.sources.length }}）</h3>

          <p v-if="!sources.sources.length" class="panel__empty">
            还没有内容源。可以在上方添加订阅地址，或导入本地 M3U 文件。
          </p>

          <ul v-else class="src-list">
            <li
              v-for="source in sources.sources"
              :key="source.id"
              class="src-item"
              :class="{ 'src-item--active': source.id === sources.activeSourceId }"
              @click="source.id !== undefined && sources.setViewing(source.id)"
            >
              <div class="src-item__main">
                <span class="src-item__name" :title="source.url || source.name">{{ source.name }}</span>
                <div class="src-item__meta">
                  <span class="badge">{{ sourceKindLabel(source.kind) }}</span>
                  <span v-if="source.kind === 'maccms'" class="src-item__count">
                    {{ source.classes?.length ?? 0 }} 个分类
                  </span>
                  <span v-else-if="source.kind !== 'single'" class="src-item__count">
                    {{ sources.channelsOf(source.id ?? null).length }} 频道
                  </span>
                  <span v-if="sources.refreshingId === source.id" class="src-item__count">刷新中…</span>
                </div>
              </div>

              <div class="src-item__actions">
                <button
                  v-if="source.kind !== 'maccms' && /^https?:\/\//i.test(source.url)"
                  class="icon-btn"
                  title="刷新订阅"
                  :disabled="sources.refreshingId === source.id"
                  @click.stop="source.id !== undefined && refresh(source.id)"
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
                <button
                  class="icon-btn icon-btn--danger"
                  title="删除"
                  @click.stop="source.id !== undefined && remove(source.id, source.name)"
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
            </li>
          </ul>
        </section>
      </aside>

      <main class="iptv__main">
        <div v-if="!activeSource" class="empty-state">
          <p>先添加一个内容源，然后在左侧选中它</p>
        </div>

        <template v-else>
          <div class="iptv__toolbar">
            <div class="iptv__headline">
              <h3 class="iptv__source-name">{{ activeSource.name }}</h3>
              <span class="view-subtitle">
                {{ isSingle ? '单条流地址' : `${filtered.length} / ${activeChannels.length} 个频道` }}
                <template v-if="activeSource.updatedAt">
                  · 更新于 {{ formatRelative(activeSource.updatedAt) }}
                </template>
              </span>
            </div>

            <div v-if="!isSingle" class="iptv__filters">
              <input v-model="keyword" class="input iptv__search" placeholder="搜索频道…" />
              <button v-if="epg.configured" class="btn btn--ghost" :disabled="epg.loading" @click="epg.load(true)">
                {{ epg.loading ? '加载节目单…' : epg.ready ? '刷新节目单' : '加载节目单' }}
              </button>
            </div>
          </div>

          <div v-if="!isSingle && sources.groups.length > 1" class="chips">
            <button class="chip" :class="{ 'chip--active': activeGroup === '' }" @click="activeGroup = ''">
              全部
              <span class="chip__count">{{ activeChannels.length }}</span>
            </button>
            <button
              v-for="group in sources.groups"
              :key="group.name"
              class="chip"
              :class="{ 'chip--active': activeGroup === group.name }"
              @click="activeGroup = group.name"
            >
              {{ group.name }}
              <span class="chip__count">{{ group.count }}</span>
            </button>
          </div>

          <p v-if="epg.error" class="iptv__epg-note">{{ epg.error }}</p>
          <p v-else-if="epg.ready" class="iptv__epg-note">
            节目单已加载：{{ epg.channelCount }} 个频道 · {{ epg.programmeCount }} 条节目
            <template v-if="epg.fromCache && epg.loadedAt">
              （缓存于 {{ formatRelative(epg.loadedAt) }}）
            </template>
          </p>

          <!-- 单条流：直接给一个播放入口 -->
          <div v-if="isSingle" class="single-card panel">
            <div class="single-card__info">
              <span class="single-card__name">{{ activeSource.name }}</span>
              <span class="single-card__url" :title="activeSource.url">{{ activeSource.url }}</span>
            </div>
            <button class="btn btn--primary" @click="playChannel(activeSource.url, activeSource.name)">
              开始播放
            </button>
          </div>

          <template v-else>
            <p v-if="!filtered.length" class="panel__empty iptv__empty">
              {{ activeChannels.length ? '没有匹配的频道' : '该源没有可播放的频道' }}
            </p>

            <ul v-else class="ch-list scroll-area">
              <li v-for="row in rows" :key="row.channel.id ?? row.channel.url" class="ch">
                <button
                  class="ch__main"
                  :title="row.channel.url"
                  @click="playChannel(row.channel.url, row.channel.name)"
                >
                  <span class="ch__logo">
                    <img
                      v-if="row.channel.logo"
                      :src="row.channel.logo"
                      alt=""
                      loading="lazy"
                      @error="($event.target as HTMLImageElement).style.display = 'none'"
                    />
                    <span v-else class="ch__logo-text">{{ row.channel.name.charAt(0) }}</span>
                  </span>

                  <span class="ch__text">
                    <span class="ch__name">{{ row.channel.name }}</span>
                    <span v-if="row.epg.title" class="ch__epg">
                      <span class="ch__epg-now">
                        <span class="ch__epg-time">{{ row.epg.time }}</span>
                        {{ row.epg.title }}
                      </span>
                      <span v-if="row.epg.next" class="ch__epg-next">
                        接下来 {{ row.epg.nextTime }} {{ row.epg.next }}
                      </span>
                    </span>
                    <span v-else-if="row.channel.group" class="ch__group">{{ row.channel.group }}</span>
                  </span>

                  <span v-if="row.epg.title" class="ch__progress">
                    <span class="ch__progress-track">
                      <span class="ch__progress-bar" :style="{ width: row.epg.percent + '%' }"></span>
                    </span>
                  </span>
                </button>
              </li>
            </ul>

            <button v-if="hasMore" class="btn iptv__more" @click="limit += PAGE_SIZE">
              加载更多（还剩 {{ filtered.length - visible.length }} 个）
            </button>
          </template>
        </template>
      </main>
    </div>
  </div>
</template>

<style scoped>
.iptv {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.iptv__spacer {
  flex: 1;
}

.iptv__toast {
  margin: 0 24px 6px;
  padding: 8px 14px;
  border-radius: 8px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 13px;
}

.iptv__body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 300px minmax(0, 1fr);
  gap: 16px;
  padding: 4px 24px 20px;
}

.iptv__side {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding-right: 4px;
}

.iptv__main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
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
  line-height: 1.7;
}

.iptv__side .panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.segmented {
  display: inline-flex;
  padding: 3px;
  border-radius: 9px;
  background: var(--surface-2);
  gap: 2px;
}

.segmented button {
  flex: 1;
  height: 28px;
  padding: 0 10px;
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

.src-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.src-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 10px;
  border-radius: 10px;
  background: var(--surface-2);
  border: 1px solid transparent;
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease;
}

.src-item:hover {
  border-color: var(--border-strong);
}

.src-item--active {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.src-item__main {
  flex: 1;
  min-width: 0;
}

.src-item__name {
  display: block;
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.src-item__meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 3px;
}

.src-item__count {
  font-size: 11.5px;
  color: var(--text-faint);
}

.badge {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 6px;
  border-radius: 5px;
  background: var(--surface-3);
  color: var(--text-muted);
  font-size: 11px;
}

.src-item__actions {
  display: flex;
  gap: 2px;
  flex-shrink: 0;
}

.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: none;
  border-radius: 7px;
  background: transparent;
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

.icon-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.iptv__toolbar {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.iptv__headline {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.iptv__source-name {
  font-size: 15px;
}

.iptv__filters {
  display: flex;
  align-items: center;
  gap: 8px;
}

.iptv__search {
  width: 200px;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  max-height: 96px;
  overflow-y: auto;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface-2);
  color: var(--text-muted);
  font-size: 12.5px;
  cursor: pointer;
  transition: border-color 0.15s ease, color 0.15s ease, background 0.15s ease;
}

.chip:hover {
  border-color: var(--border-strong);
  color: var(--text);
}

.chip--active {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}

.chip__count {
  font-size: 11px;
  opacity: 0.75;
}

.iptv__epg-note {
  margin: 0;
  font-size: 12px;
  color: var(--text-faint);
}

.single-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.single-card__info {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.single-card__name {
  font-size: 14px;
}

.single-card__url {
  font-size: 12px;
  color: var(--text-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.iptv__empty {
  padding: 24px 0;
  text-align: center;
}

.ch-list {
  flex: 1;
  min-height: 0;
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.ch__main {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 10px;
  border: 1px solid transparent;
  border-radius: 10px;
  background: var(--surface-2);
  color: var(--text);
  text-align: left;
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease;
}

.ch__main:hover {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.ch__logo {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  flex-shrink: 0;
  border-radius: 8px;
  overflow: hidden;
  background: var(--surface-3);
  color: var(--text-faint);
}

.ch__logo img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.ch__logo-text {
  font-size: 15px;
  font-weight: 500;
}

.ch__text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.ch__name {
  font-size: 13.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ch__group {
  font-size: 11.5px;
  color: var(--text-faint);
}

.ch__epg {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-size: 11.5px;
}

.ch__epg-now {
  color: var(--accent);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ch__epg-time {
  color: var(--text-faint);
  margin-right: 4px;
  font-variant-numeric: tabular-nums;
}

.ch__epg-next {
  color: var(--text-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex-shrink: 0;
  max-width: 40%;
}

.ch__progress {
  width: 90px;
  flex-shrink: 0;
}

.ch__progress-track {
  display: block;
  height: 3px;
  border-radius: 2px;
  background: var(--surface-3);
  overflow: hidden;
}

.ch__progress-bar {
  display: block;
  height: 100%;
  border-radius: 2px;
  background: var(--accent);
  transition: width 0.4s ease;
}

.iptv__more {
  align-self: center;
  flex-shrink: 0;
}
</style>
