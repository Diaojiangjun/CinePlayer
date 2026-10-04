<script setup lang="ts">
import { useRouter } from 'vue-router'
import { useHistoryStore } from '@renderer/stores/history'
import { formatDuration, formatRelative } from '@renderer/utils/format'

const router = useRouter()
const history = useHistoryStore()

function resume(path: string, title: string): void {
  router.push({ name: 'play', query: { path, title } })
}

async function clearAll(): Promise<void> {
  if (!history.records.length) return
  if (!window.confirm('确定清空所有播放历史吗？')) return
  await history.clear()
}

function percent(position: number, duration: number): number {
  if (!duration) return 0
  return Math.min((position / duration) * 100, 100)
}
</script>

<template>
  <div class="history">
    <header class="view-header">
      <div>
        <h2 class="view-title">播放历史</h2>
        <span class="view-subtitle">共 {{ history.records.length }} 条记录</span>
      </div>
      <div class="history__spacer"></div>
      <button class="btn btn--ghost btn--danger" :disabled="!history.records.length" @click="clearAll">
        清空历史
      </button>
    </header>

    <div class="history__body scroll-area">
      <div v-if="!history.records.length" class="empty-state">
        <p>还没有播放记录</p>
      </div>

      <ul v-else class="history__list">
        <li v-for="record in history.records" :key="record.path" class="record">
          <div class="record__main">
            <div class="record__head">
              <span class="record__title">{{ record.title }}</span>
              <span class="record__time">{{ formatRelative(record.playedAt) }}</span>
            </div>
            <div class="record__progress">
              <div
                class="record__progress-bar"
                :style="{ width: percent(record.position, record.duration) + '%' }"
              ></div>
            </div>
            <div class="record__meta">
              <span>{{ formatDuration(record.position) }} / {{ formatDuration(record.duration) }}</span>
              <span class="record__path" :title="record.path">{{ record.path }}</span>
            </div>
          </div>

          <div class="record__actions">
            <button class="btn" @click="resume(record.path, record.title)">
              {{ record.position > 0 ? '继续播放' : '播放' }}
            </button>
            <button
              class="btn btn--ghost btn--danger"
              @click="record.id !== undefined && history.remove(record.id)"
            >
              删除
            </button>
          </div>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.history {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.history__spacer {
  flex: 1;
}

.history__body {
  flex: 1;
  padding: 4px 24px 24px;
}

.history__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.record {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 14px 16px;
  border-radius: 12px;
  background: var(--surface);
  border: 1px solid var(--border);
}

.record__main {
  flex: 1;
  min-width: 0;
}

.record__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.record__title {
  font-size: 14px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.record__time {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--text-faint);
}

.record__progress {
  height: 4px;
  margin: 8px 0 6px;
  border-radius: 2px;
  background: var(--surface-3);
  overflow: hidden;
}

.record__progress-bar {
  height: 100%;
  background: var(--accent);
}

.record__meta {
  display: flex;
  gap: 12px;
  font-size: 12px;
  color: var(--text-muted);
}

.record__path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-faint);
}

.record__actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}
</style>
