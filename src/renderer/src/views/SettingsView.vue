<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useSettingsStore } from '@renderer/stores/settings'
import { useLibraryStore } from '@renderer/stores/library'
import { useHistoryStore } from '@renderer/stores/history'
import { useFavoriteStore } from '@renderer/stores/favorite'
import { useSourcesStore } from '@renderer/stores/sources'
import { useCollectStore } from '@renderer/stores/collect'
import { useEpgStore } from '@renderer/stores/epg'
import { cacheClear, cacheStats, type CacheStats } from '@renderer/utils/cache'
import { formatRelative, formatSize } from '@renderer/utils/format'

const settings = useSettingsStore()
const library = useLibraryStore()
const history = useHistoryStore()
const favorite = useFavoriteStore()
const sources = useSourcesStore()
const collect = useCollectStore()
const epg = useEpgStore()

const epgInput = ref('')
watch(
  () => settings.settings.epgUrl,
  (value) => (epgInput.value = value ?? ''),
  { immediate: true }
)

const message = ref('')
let flashTimer: number | undefined

function flash(text: string): void {
  message.value = text
  window.clearTimeout(flashTimer)
  flashTimer = window.setTimeout(() => (message.value = ''), 2800)
}

async function addFolder(): Promise<void> {
  const dir = await window.api.dialog.openFolder()
  if (!dir) return
  await settings.addScanFolder(dir)
  flash('已加入扫描目录')
}

async function rescan(dir: string): Promise<void> {
  const count = await library.rescanFolder(dir)
  flash(count > 0 ? `本次新增 ${count} 个视频` : '没有发现新视频')
}

async function clearLibrary(): Promise<void> {
  if (!window.confirm('确定清空媒体库吗？（不会删除原文件）')) return
  await library.clearAll()
  flash('媒体库已清空')
}

async function clearHistory(): Promise<void> {
  if (!window.confirm('确定清空播放历史吗？')) return
  await history.clear()
  flash('播放历史已清空')
}

async function clearFavorite(): Promise<void> {
  if (!window.confirm('确定清空收藏夹吗？')) return
  await favorite.clear()
  flash('收藏夹已清空')
}

async function saveEpg(): Promise<void> {
  const url = epgInput.value.trim()
  await settings.update({ epgUrl: url })
  if (!url) {
    await epg.clear()
    flash('已清空节目单地址')
    return
  }
  await epg.load(true)
  flash(
    epg.error
      ? `节目单加载失败：${epg.error}`
      : `已加载 ${epg.channelCount} 个频道 · ${epg.programmeCount} 条节目`
  )
}

/* -------------------------------- 缓存 -------------------------------- */

const TTL_OPTIONS = [
  { label: '15 分钟', minutes: 15 },
  { label: '1 小时', minutes: 60 },
  { label: '6 小时', minutes: 360 },
  { label: '1 天', minutes: 1440 },
  { label: '关闭', minutes: 0 }
]

const cacheInfo = ref<CacheStats | null>(null)
const mediaCacheBytes = ref(0)

const cacheText = computed(() => {
  const info = cacheInfo.value
  if (!info) return '统计中…'
  if (!info.total) return '暂无缓存内容'
  const parts = [
    info.list ? `列表 ${info.list}` : '',
    info.detail ? `详情 ${info.detail}` : '',
    info.epg ? `节目单 ${info.epg}` : ''
  ].filter(Boolean)
  const size = `${info.approximate ? '≥ ' : ''}${formatSize(info.bytes)}`
  const latest = info.latest ? ` · 最近 ${formatRelative(info.latest)}` : ''
  return `${parts.join(' · ')} · 约 ${size}${latest}`
})

async function loadCacheInfo(): Promise<void> {
  const [info, bytes] = await Promise.all([cacheStats(), window.api.media.cacheSize()])
  cacheInfo.value = info
  mediaCacheBytes.value = bytes
}

async function clearContentCache(): Promise<void> {
  const total = cacheInfo.value?.total ?? 0
  if (!total) return
  if (!window.confirm('确定清除内容缓存吗？下次浏览会重新向采集站请求。')) return
  await cacheClear()
  collect.onCacheCleared()
  epg.onCacheCleared()
  await loadCacheInfo()
  flash(`已清除 ${total} 条内容缓存`)
}

async function clearMediaCache(): Promise<void> {
  if (!mediaCacheBytes.value) return
  if (!window.confirm('确定清除视频转换缓存吗？再次播放需要重新转换。')) return
  const removed = await window.api.media.clearCache()
  await loadCacheInfo()
  flash(`已清除 ${removed} 个转换缓存文件`)
}

onMounted(() => {
  void loadCacheInfo()
})

async function clearSources(): Promise<void> {
  if (!sources.sources.length) return
  if (!window.confirm('确定清空所有内容源吗？（含直播订阅与采集源）')) return
  for (const source of [...sources.sources]) {
    if (source.id !== undefined) await sources.removeSource(source.id)
  }
  flash('已清空内容源')
}

async function clearCollections(): Promise<void> {
  if (!collect.collections.length) return
  if (!window.confirm('确定清空追剧收藏吗？')) return
  await collect.clearCollections()
  flash('追剧收藏已清空')
}
</script>

<template>
  <div class="settings">
    <header class="view-header">
      <div>
        <h2 class="view-title">设置</h2>
        <span class="view-subtitle">偏好会自动保存在本地</span>
      </div>
    </header>

    <div v-if="message" class="settings__toast">{{ message }}</div>

    <div class="settings__body scroll-area">
      <section class="panel">
        <h3 class="panel__title">外观</h3>

        <div class="row">
          <div class="row__label">
            <span>主题</span>
            <span class="row__hint">深色 / 浅色</span>
          </div>
          <div class="segmented">
            <button
              :class="{ active: settings.settings.theme === 'dark' }"
              @click="settings.update({ theme: 'dark' })"
            >
              深色
            </button>
            <button
              :class="{ active: settings.settings.theme === 'light' }"
              @click="settings.update({ theme: 'light' })"
            >
              浅色
            </button>
          </div>
        </div>

        <div class="row">
          <div class="row__label">
            <span>媒体库默认视图</span>
            <span class="row__hint">打开媒体库时的呈现方式</span>
          </div>
          <div class="segmented">
            <button
              :class="{ active: settings.settings.libraryView === 'poster' }"
              @click="settings.update({ libraryView: 'poster' })"
            >
              海报
            </button>
            <button
              :class="{ active: settings.settings.libraryView === 'list' }"
              @click="settings.update({ libraryView: 'list' })"
            >
              列表
            </button>
          </div>
        </div>
      </section>

      <section class="panel">
        <h3 class="panel__title">播放</h3>

        <div class="row">
          <div class="row__label">
            <span>默认音量</span>
            <span class="row__hint">{{ Math.round(settings.settings.volume * 100) }}%</span>
          </div>
          <input
            class="settings__range"
            type="range"
            min="0"
            max="1"
            step="0.05"
            :value="settings.settings.volume"
            @input="settings.update({ volume: Number(($event.target as HTMLInputElement).value) })"
          />
        </div>

        <div class="row">
          <div class="row__label">
            <span>默认倍速</span>
            <span class="row__hint">{{ settings.settings.playbackRate }}x</span>
          </div>
          <div class="segmented">
            <button
              v-for="rate in [0.75, 1, 1.25, 1.5, 2]"
              :key="rate"
              :class="{ active: settings.settings.playbackRate === rate }"
              @click="settings.update({ playbackRate: rate })"
            >
              {{ rate }}x
            </button>
          </div>
        </div>

        <div class="row">
          <div class="row__label">
            <span>记忆播放进度</span>
            <span class="row__hint">再次打开时从上次位置继续</span>
          </div>
          <label class="switch">
            <input
              type="checkbox"
              :checked="settings.settings.rememberProgress"
              @change="
                settings.update({
                  rememberProgress: ($event.target as HTMLInputElement).checked
                })
              "
            />
            <span class="switch__track"></span>
          </label>
        </div>

        <div class="row">
          <div class="row__label">
            <span>续播阈值</span>
            <span class="row__hint">进度超过 {{ settings.settings.resumeThreshold }} 秒才记忆</span>
          </div>
          <input
            class="settings__number"
            type="number"
            min="0"
            max="300"
            :value="settings.settings.resumeThreshold"
            @change="
              settings.update({
                resumeThreshold: Number(($event.target as HTMLInputElement).value) || 0
              })
            "
          />
        </div>
      </section>

      <section class="panel">
        <h3 class="panel__title">电视直播与节目单</h3>

        <div class="url-row">
          <input
            v-model="epgInput"
            class="input url-row__input"
            placeholder="https://example.com/epg.xml.gz（XMLTV 格式，可选）"
            @keyup.enter="saveEpg"
          />
          <button class="btn btn--primary" :disabled="epg.loading" @click="saveEpg">
            {{ epg.loading ? '加载中…' : '保存并加载' }}
          </button>
        </div>

        <p class="panel__empty">
          <template v-if="epg.ready">
            已加载 {{ epg.channelCount }} 个频道 · {{ epg.programmeCount }} 条节目，直播页会显示「正在播出」。
          </template>
          <template v-else-if="epg.error">{{ epg.error }}</template>
          <template v-else>
            支持 .xml 与 .xml.gz 的 XMLTV 节目单，配置后直播列表会显示当前与下一档节目。
          </template>
        </p>
      </section>

      <section class="panel">
        <div class="panel__head">
          <h3 class="panel__title">扫描目录</h3>
          <button class="btn" @click="addFolder">添加目录</button>
        </div>

        <p v-if="!settings.settings.scanFolders.length" class="panel__empty">
          还没有添加扫描目录，媒体库可通过「导入目录」临时添加。
        </p>

        <ul v-else class="folder-list">
          <li v-for="folder in settings.settings.scanFolders" :key="folder" class="folder">
            <span class="folder__path" :title="folder">{{ folder }}</span>
            <div class="folder__actions">
              <button class="btn btn--ghost" :disabled="library.loading" @click="rescan(folder)">
                重新扫描
              </button>
              <button class="btn btn--ghost btn--danger" @click="settings.removeScanFolder(folder)">
                移除
              </button>
            </div>
          </li>
        </ul>
      </section>

      <section class="panel">
        <div class="panel__head">
          <h3 class="panel__title">缓存</h3>
          <button class="btn btn--ghost" @click="loadCacheInfo">重新统计</button>
        </div>

        <div class="row">
          <div class="row__label">
            <span>内容缓存有效期</span>
            <span class="row__hint">浏览过的分类、影片详情与节目单在此时间内不再重新请求</span>
          </div>
          <div class="segmented segmented--wrap">
            <button
              v-for="option in TTL_OPTIONS"
              :key="option.minutes"
              :class="{ active: settings.settings.contentCacheMinutes === option.minutes }"
              @click="settings.update({ contentCacheMinutes: option.minutes })"
            >
              {{ option.label }}
            </button>
          </div>
        </div>

        <div class="row">
          <div class="row__label">
            <span>内容缓存</span>
            <span class="row__hint">{{ cacheText }}</span>
          </div>
          <button class="btn btn--danger" :disabled="!cacheInfo?.total" @click="clearContentCache">
            清除
          </button>
        </div>

        <div class="row">
          <div class="row__label">
            <span>视频转换缓存</span>
            <span class="row__hint">转封装 / 转码后的本地副本 · {{ formatSize(mediaCacheBytes) }}</span>
          </div>
          <button class="btn btn--danger" :disabled="!mediaCacheBytes" @click="clearMediaCache">
            清除
          </button>
        </div>

        <p class="panel__empty">
          <template v-if="!settings.settings.contentCacheMinutes">
            内容缓存已关闭：每次进入页面都会重新向采集站与节目单地址请求。
          </template>
          <template v-else>
            超出新鲜期后会先显示缓存内容，再在后台静默刷新，因此界面不会出现空白等待。
          </template>
        </p>
      </section>

      <section class="panel panel--danger">
        <h3 class="panel__title">数据管理</h3>
        <div class="danger-actions">
          <button class="btn btn--danger" @click="clearLibrary">清空媒体库</button>
          <button class="btn btn--danger" @click="clearHistory">清空播放历史</button>
          <button class="btn btn--danger" @click="clearFavorite">清空收藏夹</button>
          <button class="btn btn--danger" @click="clearSources">清空内容源</button>
          <button class="btn btn--danger" @click="clearCollections">清空追剧收藏</button>
        </div>
        <p class="panel__empty">以上操作只清除应用内记录，不会删除磁盘上的原始文件。</p>
      </section>

      <section class="panel about">
        <h3 class="panel__title">关于 CinePlayer</h3>
        <p class="about__desc">
          跨平台桌面影视播放器，基于 Electron + Vue 3 + TypeScript 构建。
          支持本地视频播放（含 FFmpeg 转封装与转码）、媒体库管理、
          IPTV 直播订阅与 XMLTV 节目单、苹果CMS 采集接口点播、播放历史与收藏，
          并对采集内容做本地缓存以避免重复加载。
        </p>
        <div class="about__meta">
          <span class="tag">版本 1.0.0</span>
          <span class="tag">Electron</span>
          <span class="tag">Vue 3</span>
          <span class="tag">TypeScript</span>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.settings {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.settings__toast {
  margin: 0 24px 6px;
  padding: 8px 14px;
  border-radius: 8px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 13px;
}

.settings__body {
  flex: 1;
  padding: 4px 24px 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.panel {
  padding: 16px;
  border-radius: 12px;
  background: var(--surface);
  border: 1px solid var(--border);
}

.panel--danger {
  border-color: color-mix(in srgb, var(--danger) 32%, transparent);
}

.panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.panel__title {
  font-size: 14px;
  margin-bottom: 12px;
}

.panel__head .panel__title {
  margin-bottom: 0;
}

.panel__empty {
  margin: 8px 0 0;
  font-size: 13px;
  color: var(--text-muted);
}

.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 0;
  border-bottom: 1px solid var(--border);
}

.row:last-child {
  border-bottom: none;
}

.row__label {
  display: flex;
  flex-direction: column;
}

.row__hint {
  font-size: 12px;
  color: var(--text-faint);
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
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}

.segmented button.active {
  background: var(--accent);
  color: #fff;
}

.segmented--wrap {
  flex-wrap: wrap;
  justify-content: flex-end;
}

.segmented--wrap button {
  padding: 0 10px;
  font-size: 12.5px;
}

.settings__range {
  width: 180px;
  accent-color: var(--accent);
}

.url-row {
  display: flex;
  gap: 10px;
}

.url-row__input {
  flex: 1;
  min-width: 0;
}

.settings__number {
  width: 80px;
  height: 32px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-2);
  color: var(--text);
}

.switch {
  position: relative;
  display: inline-block;
  width: 44px;
  height: 24px;
}

.switch input {
  opacity: 0;
  width: 0;
  height: 0;
}

.switch__track {
  position: absolute;
  inset: 0;
  border-radius: 999px;
  background: var(--surface-3);
  transition: background 0.18s ease;
}

.switch__track::after {
  content: '';
  position: absolute;
  top: 3px;
  left: 3px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #fff;
  transition: transform 0.18s ease;
}

.switch input:checked + .switch__track {
  background: var(--accent);
}

.switch input:checked + .switch__track::after {
  transform: translateX(20px);
}

.folder-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.folder {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  border-radius: 10px;
  background: var(--surface-2);
}

.folder__path {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.folder__actions {
  display: flex;
  gap: 6px;
}

.danger-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.about__desc {
  margin: 0 0 12px;
  font-size: 13px;
  color: var(--text-muted);
  line-height: 1.7;
}

.about__meta {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
</style>
