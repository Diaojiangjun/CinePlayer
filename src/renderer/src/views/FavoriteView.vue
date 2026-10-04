<script setup lang="ts">
import { useRouter } from 'vue-router'
import { useFavoriteStore } from '@renderer/stores/favorite'
import { formatRelative } from '@renderer/utils/format'

const router = useRouter()
const favorite = useFavoriteStore()

function play(path: string, title: string): void {
  router.push({ name: 'play', query: { path, title } })
}

async function clearAll(): Promise<void> {
  if (!favorite.items.length) return
  if (!window.confirm('确定清空收藏夹吗？')) return
  await favorite.clear()
}
</script>

<template>
  <div class="favorite">
    <header class="view-header">
      <div>
        <h2 class="view-title">我的收藏</h2>
        <span class="view-subtitle">共 {{ favorite.items.length }} 个</span>
      </div>
      <div class="favorite__spacer"></div>
      <button
        class="btn btn--ghost btn--danger"
        :disabled="!favorite.items.length"
        @click="clearAll"
      >
        清空收藏
      </button>
    </header>

    <div class="favorite__body scroll-area">
      <div v-if="!favorite.items.length" class="empty-state">
        <p>收藏夹是空的</p>
        <p class="favorite__hint">在播放页点击右上角的爱心即可收藏</p>
      </div>

      <div v-else class="grid">
        <article
          v-for="item in favorite.items"
          :key="item.path"
          class="fav-card"
          @click="play(item.path, item.title)"
        >
          <div class="fav-card__cover">
            <span class="fav-card__initial">{{ item.title.charAt(0) }}</span>
            <span class="fav-card__kind">{{ item.kind === 'stream' ? '流' : '本地' }}</span>
          </div>
          <div class="fav-card__info">
            <p class="fav-card__title" :title="item.title">{{ item.title }}</p>
            <span class="fav-card__time">{{ formatRelative(item.addedAt) }}</span>
          </div>
          <button class="fav-card__remove" title="取消收藏" @click.stop="item.id !== undefined && favorite.remove(item.id)">
            <svg viewBox="0 0 24 24" width="16" height="16">
              <path
                d="M6 6l12 12M18 6L6 18"
                fill="none"
                stroke="currentColor"
                stroke-width="1.9"
                stroke-linecap="round"
              />
            </svg>
          </button>
        </article>
      </div>
    </div>
  </div>
</template>

<style scoped>
.favorite {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.favorite__spacer {
  flex: 1;
}

.favorite__body {
  flex: 1;
  padding: 4px 24px 24px;
}

.favorite__hint {
  font-size: 13px;
  color: var(--text-faint);
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(158px, 1fr));
  gap: 16px;
}

.fav-card {
  position: relative;
  cursor: pointer;
  border-radius: 12px;
  overflow: hidden;
  background: var(--surface);
  border: 1px solid var(--border);
  transition: transform 0.18s ease, box-shadow 0.18s ease;
}

.fav-card:hover {
  transform: translateY(-3px);
  box-shadow: var(--shadow);
}

.fav-card__cover {
  position: relative;
  aspect-ratio: 2 / 3;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, var(--accent), #7c5cff);
}

.fav-card__initial {
  font-size: 42px;
  font-weight: 500;
  color: rgba(255, 255, 255, 0.92);
}

.fav-card__kind {
  position: absolute;
  right: 8px;
  bottom: 8px;
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.5);
  color: #fff;
  font-size: 11px;
}

.fav-card__info {
  padding: 8px 10px 10px;
}

.fav-card__title {
  margin: 0;
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.fav-card__time {
  font-size: 12px;
  color: var(--text-faint);
}

.fav-card__remove {
  position: absolute;
  top: 8px;
  right: 8px;
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
  opacity: 0;
  transition: opacity 0.15s ease, background 0.15s ease;
}

.fav-card:hover .fav-card__remove {
  opacity: 1;
}

.fav-card__remove:hover {
  background: var(--danger);
}
</style>
