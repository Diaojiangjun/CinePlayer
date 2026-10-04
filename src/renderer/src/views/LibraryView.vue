<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useLibraryStore } from '@renderer/stores/library'
import { useQueueStore } from '@renderer/stores/queue'
import { useSettingsStore } from '@renderer/stores/settings'
import { formatSize } from '@renderer/utils/format'
import type { MediaItem } from '@renderer/db/types'

const router = useRouter()
const library = useLibraryStore()
const queue = useQueueStore()
const settings = useSettingsStore()

const message = ref('')
let flashTimer: number | undefined

const isPoster = computed(() => settings.settings.libraryView === 'poster')

function flash(text: string): void {
  message.value = text
  window.clearTimeout(flashTimer)
  flashTimer = window.setTimeout(() => (message.value = ''), 2600)
}

function hueOf(text: string): number {
  let h = 0
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) % 360
  return h
}

function coverStyle(item: MediaItem): Record<string, string> {
  const hue = hueOf(item.title)
  return {
    background: `linear-gradient(135deg, hsl(${hue} 52% 32%), hsl(${(hue + 42) % 360} 48% 20%))`
  }
}

function initial(item: MediaItem): string {
  return item.title.trim().charAt(0).toUpperCase() || '?'
}

async function importFiles(): Promise<void> {
  try {
    const count = await library.importFiles()
    flash(count > 0 ? `已导入 ${count} 个视频` : '没有新增视频（可能已存在）')
  } catch (error) {
    flash(`导入失败：${error instanceof Error ? error.message : '未知错误'}`)
  }
}

async function importFolder(): Promise<void> {
  try {
    const count = await library.importFolder()
    flash(count > 0 ? `已扫描并导入 ${count} 个视频` : '该目录没有发现新视频')
  } catch (error) {
    flash(`扫描失败：${error instanceof Error ? error.message : '未知错误'}`)
  }
}

async function toggleView(): Promise<void> {
  await settings.update({ libraryView: isPoster.value ? 'list' : 'poster' })
}

function play(item: MediaItem): void {
  // 把当前筛选结果整体交给播放器，播放页的「选集」面板就成了一串连播列表
  const list = library.filtered
  queue.set(
    list.map((entry) => ({ src: entry.path, name: entry.title, title: entry.title })),
    '媒体库'
  )
  router.push({ name: 'play', query: { path: item.path, title: item.title } })
}

async function remove(item: MediaItem): Promise<void> {
  if (item.id === undefined) return
  if (!window.confirm(`确定从媒体库移除「${item.title}」吗？（不会删除原文件）`)) return
  await library.remove(item.id)
  flash('已从媒体库移除')
}

async function clearAll(): Promise<void> {
  if (!library.items.length) return
  if (!window.confirm('确定清空整个媒体库吗？（不会删除原文件）')) return
  await library.clearAll()
  flash('媒体库已清空')
}
</script>

<template>
  <div class="library">
    <header class="view-header">
      <div>
        <h2 class="view-title">媒体库</h2>
        <span class="view-subtitle">
          {{ library.items.length }} 个视频 · {{ formatSize(library.totalSize) }}
        </span>
      </div>

      <div class="library__spacer"></div>

      <input
        v-model="library.keyword"
        class="input library__search"
        type="search"
        placeholder="搜索标题或路径…"
      />

      <button class="btn" @click="toggleView">
        {{ isPoster ? '列表模式' : '海报模式' }}
      </button>
      <button class="btn" :disabled="library.loading" @click="importFiles">导入文件</button>
      <button class="btn btn--primary" :disabled="library.loading" @click="importFolder">
        {{ library.loading ? '扫描中…' : '导入目录' }}
      </button>
    </header>

    <div v-if="message" class="library__toast">{{ message }}</div>

    <div class="library__body scroll-area">
      <div v-if="!library.filtered.length" class="empty-state">
        <p v-if="library.keyword">没有匹配「{{ library.keyword }}」的视频</p>
        <template v-else>
          <p>媒体库还是空的</p>
          <div class="library__empty-actions">
            <button class="btn btn--primary" @click="importFolder">扫描一个目录</button>
            <button class="btn" @click="importFiles">选择视频文件</button>
          </div>
        </template>
      </div>

      <div v-else-if="isPoster" class="grid">
        <article
          v-for="item in library.filtered"
          :key="item.path"
          class="poster"
          @click="play(item)"
        >
          <div class="poster__cover" :style="coverStyle(item)">
            <span class="poster__initial">{{ initial(item) }}</span>
            <span class="poster__ext">{{ item.ext.toUpperCase() }}</span>
          </div>
          <div class="poster__info">
            <p class="poster__title" :title="item.path">{{ item.title }}</p>
            <span class="poster__meta">{{ formatSize(item.size) }}</span>
          </div>
          <div class="poster__actions">
            <button class="poster__action" title="移除" @click.stop="remove(item)">
              <svg viewBox="0 0 24 24" width="16" height="16">
                <path
                  d="M6 7h12M9 7V5h6v2m-8 0l1 13h8l1-13"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.7"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </button>
          </div>
        </article>
      </div>

      <table v-else class="list">
        <thead>
          <tr>
            <th>标题</th>
            <th>格式</th>
            <th>大小</th>
            <th>所在目录</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in library.filtered" :key="item.path" @click="play(item)">
            <td class="list__title">{{ item.title }}</td>
            <td>{{ item.ext.toUpperCase() }}</td>
            <td>{{ formatSize(item.size) }}</td>
            <td class="list__folder" :title="item.folder">{{ item.folder }}</td>
            <td>
              <button class="btn btn--ghost btn--danger" @click.stop="remove(item)">移除</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <footer v-if="library.items.length" class="library__footer">
      <button class="btn btn--ghost btn--danger" @click="clearAll">清空媒体库</button>
    </footer>
  </div>
</template>

<style scoped>
.library {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.library__spacer {
  flex: 1;
}

.library__search {
  width: 220px;
}

.library__body {
  flex: 1;
  padding: 4px 24px 24px;
}

.library__toast {
  margin: 0 24px 6px;
  padding: 8px 14px;
  border-radius: 8px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 13px;
}

.library__empty-actions {
  display: flex;
  gap: 10px;
  margin-top: 6px;
}

.library__footer {
  padding: 10px 24px 16px;
  display: flex;
  justify-content: flex-end;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(158px, 1fr));
  gap: 16px;
}

.poster {
  position: relative;
  cursor: pointer;
  border-radius: 12px;
  overflow: hidden;
  background: var(--surface);
  border: 1px solid var(--border);
  transition: transform 0.18s ease, box-shadow 0.18s ease;
}

.poster:hover {
  transform: translateY(-3px);
  box-shadow: var(--shadow);
}

.poster__cover {
  position: relative;
  aspect-ratio: 2 / 3;
  display: flex;
  align-items: center;
  justify-content: center;
}

.poster__initial {
  font-size: 42px;
  font-weight: 500;
  color: rgba(255, 255, 255, 0.9);
}

.poster__ext {
  position: absolute;
  right: 8px;
  bottom: 8px;
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.5);
  color: #fff;
  font-size: 11px;
}

.poster__info {
  padding: 8px 10px 10px;
}

.poster__title {
  margin: 0;
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.poster__meta {
  font-size: 12px;
  color: var(--text-faint);
}

.poster__actions {
  position: absolute;
  top: 8px;
  right: 8px;
  opacity: 0;
  transition: opacity 0.15s ease;
}

.poster:hover .poster__actions {
  opacity: 1;
}

.poster__action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.45);
  color: #fff;
  cursor: pointer;
}

.poster__action:hover {
  background: var(--danger);
}

.list {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.list th {
  text-align: left;
  padding: 8px 12px;
  color: var(--text-muted);
  font-weight: 500;
  border-bottom: 1px solid var(--border);
  position: sticky;
  top: 0;
  background: var(--bg);
}

.list td {
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
}

.list tbody tr {
  cursor: pointer;
  transition: background 0.12s ease;
}

.list tbody tr:hover {
  background: var(--surface-2);
}

.list__title {
  font-weight: 500;
}

.list__folder {
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-muted);
}
</style>
