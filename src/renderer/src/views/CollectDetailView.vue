<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useCollectStore } from '@renderer/stores/collect'
import { useQueueStore } from '@renderer/stores/queue'
import { useSourcesStore } from '@renderer/stores/sources'
import { formatRelative } from '@renderer/utils/format'
import { dropBrokenPoster, posterGradient } from '@renderer/utils/poster'
import { vodSeriesKey } from '../../../shared/series'

const route = useRoute()
const router = useRouter()
const collect = useCollectStore()
const queue = useQueueStore()
const sources = useSourcesStore()

const activeGroup = ref(0)
const episodeKeyword = ref('')
const descending = ref(false)
const message = ref('')
let flashTimer: number | undefined

function flash(text: string): void {
  message.value = text
  window.clearTimeout(flashTimer)
  flashTimer = window.setTimeout(() => (message.value = ''), 2600)
}

const vodId = computed(() => String(route.query.id ?? ''))
const sourceId = computed(() => {
  const raw = Number(route.query.source)
  return Number.isFinite(raw) && raw > 0 ? raw : null
})
/** 归属它的采集源 id：地址里没带就退回当前选中的源 */
const activeSourceId = computed(() => sourceId.value ?? collect.activeSource?.id ?? null)
/** 「继续观看」只自动起播一次，别让返回详情页又播一遍 */
let autoPlayedFor = ''

/** 详情直接读 store，缓存命中时首帧就有内容；后台换新也会自动反映到界面 */
const vod = computed(() => (collect.lastVodId === vodId.value ? collect.lastVod : null))

const groups = computed(() => vod.value?.playGroups ?? [])
const currentGroup = computed(() => groups.value[activeGroup.value] ?? null)

const episodes = computed(() => {
  const list = currentGroup.value?.episodes ?? []
  const k = episodeKeyword.value.trim().toLowerCase()
  const filtered = k ? list.filter((item) => item.name.toLowerCase().includes(k)) : list
  return descending.value ? [...filtered].reverse() : filtered
})

const isCollected = computed(() => (vodId.value ? collect.isCollected(vodId.value) : false))

const metaLine = computed(() => {
  const item = vod.value
  if (!item) return []
  return [
    item.year,
    item.area,
    item.typeName,
    item.lang,
    item.note,
    item.score ? `评分 ${item.score}` : ''
  ].filter(Boolean) as string[]
})

async function load(force = false): Promise<void> {
  if (!vodId.value) return

  if (sourceId.value !== null && collect.activeSource?.id !== sourceId.value) {
    collect.selectSource(sourceId.value)
  }

  activeGroup.value = 0
  episodeKeyword.value = ''

  const result = await collect.open(vodId.value, { force })
  if (!result) return

  // 默认选中第一个有剧集的线路
  const index = result.playGroups.findIndex((group) => group.episodes.length > 0)
  activeGroup.value = index > 0 ? index : 0

  // 用户点开了这部追剧 —— 「有新集」标记该消掉了
  void collect.markSeen(vodId.value)

  if (!force) void maybeAutoPlay()
}

/**
 * 追剧列表的「继续观看」会带 `?ep=<下标>` 过来，直接起播那一集。
 *
 * 起播前必须把这个参数从地址里抹掉：留着的话用户从播放页返回详情页，
 * 会立刻又被弹回播放页，像是「返回按钮坏了」。
 */
async function maybeAutoPlay(): Promise<void> {
  const wanted = Number(route.query.ep)
  if (!Number.isInteger(wanted) || wanted < 0) return

  const mark = `${vodId.value}:${wanted}`
  if (autoPlayedFor === mark) return
  autoPlayedFor = mark

  // 必须等这次地址替换落地再跳播放页：两次导航挤在同一个 tick 里，
  // 后一次（去播放页）有可能被前一次的导航流程吃掉。
  await router.replace({
    name: 'collect-detail',
    query: { id: vodId.value, source: String(activeSourceId.value ?? '') }
  })

  const episode = (currentGroup.value?.episodes ?? [])[wanted]
  if (episode) playEpisode(episode.url, episode.name)
}

async function refresh(): Promise<void> {
  await load(true)
  flash(collect.detailError ? `刷新失败：${collect.detailError}` : '已重新获取详情')
}

/** 缓存状态提示 */
const cacheHint = computed(() => {
  if (!collect.detailFromCache || !collect.detailSyncAt) return ''
  return `缓存 · ${formatRelative(collect.detailSyncAt)}`
})

function playEpisode(url: string, name: string): void {
  const item = vod.value
  if (!item) return

  // 整条线路的剧集交给播放器 —— 播放页的「选集」面板据此列出全部集数并能直接切换，
  // 看完一集不用退回详情页。缓存进内存即可，塞进 URL 会污染历史记录。
  const list = currentGroup.value?.episodes ?? []
  const source = activeSourceId.value
  queue.set(
    list.map((episode) => ({
      src: episode.url,
      name: episode.name,
      title: episode.name === item.name ? item.name : `${item.name} · ${episode.name}`
    })),
    currentGroup.value?.name ? `${item.name} · ${currentGroup.value.name}` : item.name,
    // 归属到这部剧：片头片尾配置与观看进度都按它归组，换集不用重设
    source !== null && source > 0 ? vodSeriesKey(source, item.vodId) : ''
  )

  const title = item.name === name ? name : `${item.name} · ${name}`
  router.push({ name: 'play', query: { path: url, title } })
}

async function toggleStar(): Promise<void> {
  const item = vod.value
  if (!item) return
  const added = await collect.toggleCollection(item)
  flash(added ? '已加入追剧' : '已取消追剧')
}

function goBack(): void {
  if (window.history.length > 1) router.back()
  else router.push('/collect')
}

onMounted(() => {
  void sources.load().then(() => load())
})

watch(vodId, () => void load())
onBeforeUnmount(() => window.clearTimeout(flashTimer))
</script>

<template>
  <div class="detail">
    <header class="view-header">
      <button class="btn btn--ghost" @click="goBack">
        <svg viewBox="0 0 24 24" width="16" height="16">
          <path
            d="M15 5l-7 7 7 7"
            fill="none"
            stroke="currentColor"
            stroke-width="1.9"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        返回
      </button>
      <div class="detail__spacer"></div>
      <span v-if="cacheHint" class="detail__cache">{{ cacheHint }}</span>
      <span v-if="collect.activeSource" class="view-subtitle">{{ collect.activeSource.name }}</span>
      <button class="btn btn--ghost" :disabled="collect.detailLoading" @click="refresh">
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
        {{ collect.detailLoading ? '刷新中…' : '刷新' }}
      </button>
    </header>

    <div v-if="message" class="detail__toast">{{ message }}</div>

    <div class="detail__body scroll-area">
      <p v-if="collect.detailLoading" class="detail__state">正在获取详情…</p>
      <p v-else-if="collect.detailError" class="detail__state detail__state--error">
        {{ collect.detailError }}
      </p>

      <template v-else-if="vod">
        <section class="hero">
          <div class="hero__poster" :style="vod.pic ? undefined : posterGradient(vod.name)">
            <img v-if="vod.pic" :src="vod.pic" alt="" @error="dropBrokenPoster(vod)" />
            <span v-else class="hero__initial">{{ vod.name.charAt(0) }}</span>
          </div>

          <div class="hero__info">
            <h2 class="hero__name">{{ vod.name }}</h2>

            <div class="hero__meta">
              <span v-for="part in metaLine" :key="part" class="tag">{{ part }}</span>
            </div>

            <dl class="hero__facts">
              <div v-if="vod.director"><dt>导演</dt><dd>{{ vod.director }}</dd></div>
              <div v-if="vod.actor"><dt>主演</dt><dd>{{ vod.actor }}</dd></div>
              <div v-if="vod.total">
                <dt>集数</dt>
                <dd>{{ vod.serial ? `已更新 ${vod.serial} / ${vod.total}` : `共 ${vod.total} 集` }}</dd>
              </div>
              <div v-if="groups.length"><dt>线路</dt><dd>{{ groups.length }} 条</dd></div>
            </dl>

            <div class="hero__actions">
              <button
                v-if="currentGroup?.episodes.length"
                class="btn btn--primary"
                @click="playEpisode(currentGroup.episodes[0].url, currentGroup.episodes[0].name)"
              >
                播放第 1 集
              </button>
              <button class="btn" :class="{ 'btn--starred': isCollected }" @click="toggleStar">
                {{ isCollected ? '已追剧' : '加入追剧' }}
              </button>
            </div>

            <p v-if="vod.content" class="hero__desc">{{ vod.content }}</p>
          </div>
        </section>

        <section v-if="!groups.length" class="panel detail__empty">
          该影片在采集接口里没有播放地址，可能是站点未提供播放资源，或需要换一个采集源。
        </section>

        <section v-else class="panel">
          <div class="panel__head">
            <h3 class="panel__title">选集</h3>
            <div class="detail__tools">
              <input v-model="episodeKeyword" class="input detail__filter" placeholder="筛选集数…" />
              <button class="btn btn--ghost" @click="descending = !descending">
                {{ descending ? '倒序' : '正序' }}
              </button>
            </div>
          </div>

          <div v-if="groups.length > 1" class="lines">
            <button
              v-for="(group, index) in groups"
              :key="group.name + index"
              class="line"
              :class="{ 'line--active': index === activeGroup }"
              @click="activeGroup = index"
            >
              {{ group.name }}
              <span class="line__count">{{ group.episodes.length }}</span>
            </button>
          </div>

          <p v-if="!episodes.length" class="panel__empty">该线路没有可播放的集数</p>

          <div v-else class="eps">
            <button
              v-for="(episode, index) in episodes"
              :key="episode.url + index"
              class="ep"
              :title="episode.url"
              @click="playEpisode(episode.url, episode.name)"
            >
              {{ episode.name }}
            </button>
          </div>
        </section>
      </template>
    </div>
  </div>
</template>

<style scoped>
.detail {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.detail__spacer {
  flex: 1;
}

.detail__cache {
  font-size: 12px;
  color: var(--text-faint);
  white-space: nowrap;
}

.detail__toast {
  margin: 0 24px 6px;
  padding: 8px 14px;
  border-radius: 8px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 13px;
}

.detail__body {
  flex: 1;
  min-height: 0;
  padding: 4px 24px 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.detail__state {
  margin: 40px 0;
  text-align: center;
  color: var(--text-muted);
  font-size: 13.5px;
}

.detail__state--error {
  color: var(--danger);
}

.hero {
  display: flex;
  gap: 20px;
  padding: 16px;
  border-radius: 14px;
  background: var(--surface);
  border: 1px solid var(--border);
}

.hero__poster {
  width: 168px;
  flex-shrink: 0;
  aspect-ratio: 2 / 3;
  border-radius: 10px;
  overflow: hidden;
  background: var(--surface-2);
  border: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: center;
}

.hero__poster img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.hero__initial {
  font-size: 40px;
  color: rgba(255, 255, 255, 0.86);
}

.hero__info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.hero__name {
  font-size: 20px;
  line-height: 1.35;
}

.hero__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.hero__facts {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
}

.hero__facts > div {
  display: flex;
  gap: 8px;
}

.hero__facts dt {
  flex-shrink: 0;
  color: var(--text-faint);
}

.hero__facts dd {
  margin: 0;
  color: var(--text-muted);
  min-width: 0;
}

.hero__actions {
  display: flex;
  gap: 10px;
  margin-top: 2px;
}

.btn--starred {
  color: #ff6b81;
  border-color: color-mix(in srgb, #ff6b81 40%, transparent);
}

.hero__desc {
  margin: 2px 0 0;
  font-size: 13px;
  line-height: 1.8;
  color: var(--text-muted);
  max-height: 132px;
  overflow-y: auto;
  white-space: pre-wrap;
}

.panel {
  padding: 16px;
  border-radius: 12px;
  background: var(--surface);
  border: 1px solid var(--border);
}

.panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

.panel__title {
  font-size: 14px;
}

.panel__empty {
  margin: 0;
  font-size: 13px;
  color: var(--text-muted);
}

.detail__empty {
  font-size: 13px;
  color: var(--text-muted);
  line-height: 1.8;
}

.detail__tools {
  display: flex;
  align-items: center;
  gap: 8px;
}

.detail__filter {
  width: 160px;
}

.lines {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 12px;
}

.line {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 30px;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-2);
  color: var(--text-muted);
  font-size: 12.5px;
  cursor: pointer;
  transition: border-color 0.15s ease, color 0.15s ease, background 0.15s ease;
}

.line:hover {
  color: var(--text);
  border-color: var(--border-strong);
}

.line--active {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}

.line__count {
  font-size: 11px;
  opacity: 0.7;
}

.eps {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(116px, 1fr));
  gap: 8px;
  max-height: 46vh;
  overflow-y: auto;
  padding-right: 4px;
}

.ep {
  height: 34px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-2);
  color: var(--text);
  font-size: 12.5px;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: border-color 0.15s ease, background 0.15s ease;
}

.ep:hover {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}
</style>
