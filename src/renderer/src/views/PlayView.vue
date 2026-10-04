<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import PlayerCore from '@renderer/components/PlayerCore.vue'
import { useHistoryStore } from '@renderer/stores/history'
import { useFavoriteStore } from '@renderer/stores/favorite'
import { useQueueStore } from '@renderer/stores/queue'
import { useSettingsStore } from '@renderer/stores/settings'
import { useCollectStore } from '@renderer/stores/collect'
import { parseVodSeriesKey } from '../../../shared/series'

const route = useRoute()
const router = useRouter()
const history = useHistoryStore()
const favorite = useFavoriteStore()
const queue = useQueueStore()
const settings = useSettingsStore()
const collect = useCollectStore()

const topbarVisible = ref(true)
let hideTimer: number | undefined

const src = computed(() => String(route.query.path ?? ''))
const title = computed(() => String(route.query.title ?? '正在播放'))
const kind = computed<'local' | 'stream'>(() =>
  /^[a-z][a-z0-9+.-]*:\/\//i.test(src.value) ? 'stream' : 'local'
)

const startPosition = computed(() => {
  if (!settings.settings.rememberProgress) return 0
  const position = history.positionOf(src.value)
  return position > settings.settings.resumeThreshold ? position : 0
})

const isFavorite = computed(() => favorite.has(src.value))

/** 当前播放列表（剧集或媒体库连播）；不在列表里时为 -1，播放器据此隐藏「选集」 */
const episodes = computed(() => queue.items)
const episodeIndex = computed(() => queue.indexOf(src.value))

/** 选集面板里换了集：走路由跳转，这样历史记录、续播位置都能跟着更新 */
function selectEpisode(index: number): void {
  const item = queue.items[index]
  if (!item || item.src === src.value) return
  router.push({ name: 'play', query: { path: item.src, title: item.title } })
}

/**
 * 把「这部追剧看到第几集」回写到追剧列表。
 *
 * 放在播放页而不是播放器内部：播放器只负责播，它并不需要知道什么是「追剧」。
 * 列表来自采集剧集（`vod:<sourceId>:<vodId>`）时才记，媒体库连播不受影响。
 * 每切一集都会调一次，`markWatched` 内部做了去重，不会反复写库。
 */
watch(
  [() => queue.seriesKey, episodeIndex, episodes],
  () => {
    const series = parseVodSeriesKey(queue.seriesKey)
    const index = episodeIndex.value
    if (!series || index < 0) return
    const item = episodes.value[index]
    if (!item) return
    void collect.markWatched(series.sourceId, series.vodId, index, item.name)
  },
  { immediate: true }
)

function showTopbar(): void {
  topbarVisible.value = true
  window.clearTimeout(hideTimer)
  hideTimer = window.setTimeout(() => (topbarVisible.value = false), 2800)
}

function onProgress(payload: { position: number; duration: number }): void {
  if (!settings.settings.rememberProgress || !src.value) return
  history.saveProgress({
    path: src.value,
    title: title.value,
    position: payload.position,
    duration: payload.duration
  })
}

async function toggleFavorite(): Promise<void> {
  if (!src.value) return
  await favorite.toggle({ path: src.value, title: title.value, kind: kind.value })
}

function goBack(): void {
  if (window.history.length > 1) router.back()
  else router.push('/library')
}

onBeforeUnmount(() => window.clearTimeout(hideTimer))
</script>

<template>
  <div class="play" @mousemove="showTopbar">
    <PlayerCore
      :src="src"
      :autoplay="true"
      :start-position="startPosition"
      :initial-rate="settings.settings.playbackRate"
      :initial-volume="settings.settings.volume"
      :episodes="episodes"
      :episode-index="episodeIndex"
      :queue-label="queue.label"
      :series-key="queue.seriesKey"
      @progress="onProgress"
      @select="selectEpisode"
    />

    <transition name="slide">
      <header v-show="topbarVisible" class="play__topbar">
        <button class="play__action" title="返回" @click="goBack">
          <svg viewBox="0 0 24 24" width="20" height="20">
            <path
              d="M15 5l-7 7 7 7"
              fill="none"
              stroke="currentColor"
              stroke-width="1.9"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>

        <div class="play__title">
          <span class="play__name">{{ title }}</span>
          <span class="play__badge">{{ kind === 'stream' ? '流媒体' : '本地视频' }}</span>
        </div>

        <button
          class="play__action"
          :class="{ 'play__action--active': isFavorite }"
          :title="isFavorite ? '取消收藏' : '加入收藏'"
          @click="toggleFavorite"
        >
          <svg viewBox="0 0 24 24" width="20" height="20">
            <path
              d="M12 20s-7-4.4-7-9.2A4 4 0 0 1 12 8a4 4 0 0 1 7 2.8C19 15.6 12 20 12 20z"
              :fill="isFavorite ? 'currentColor' : 'none'"
              stroke="currentColor"
              stroke-width="1.7"
              stroke-linejoin="round"
            />
          </svg>
        </button>
      </header>
    </transition>

    <div v-if="!src" class="empty-state play__empty">
      <p>没有指定播放内容</p>
      <button class="btn btn--primary" @click="goBack">返回媒体库</button>
    </div>
  </div>
</template>

<style scoped>
.play {
  position: relative;
  width: 100%;
  height: 100%;
  background: #000;
}

.play__topbar {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px 22px;
  background: linear-gradient(to bottom, rgba(0, 0, 0, 0.72), rgba(0, 0, 0, 0));
  color: #fff;
}

.play__action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border: none;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.12);
  color: #fff;
  cursor: pointer;
  transition: background 0.15s ease;
}

.play__action:hover {
  background: rgba(255, 255, 255, 0.22);
}

.play__action--active {
  color: #ff6b81;
}

.play__title {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  flex: 1;
}

.play__name {
  font-size: 15px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.play__badge {
  flex-shrink: 0;
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.16);
  font-size: 11px;
}

.play__empty {
  color: var(--text-muted);
}

/**
 * 入场用 @keyframes，不用 `enter-from`。
 *
 * Vue 摘 `enter-from` 靠 requestAnimationFrame，窗口处于遮挡状态时 Chromium
 * 停掉帧生产，rAF 整帧不回调 —— 顶栏会卡在 `opacity: 0; translateY(-8px)`
 * 上，返回 / 标题 / 收藏一起「隐身」。换成时间轴驱动的动画后，底座样式就是
 * 终态，一帧不画也不会停在半路。
 */
@keyframes topbar-in {
  from {
    opacity: 0;
    transform: translateY(-8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.slide-enter-active {
  animation: topbar-in 0.2s ease;
}

/* 退场仍走 transition */
.slide-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.slide-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}
</style>
