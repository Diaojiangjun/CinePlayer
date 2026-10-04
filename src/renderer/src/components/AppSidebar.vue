<script setup lang="ts">
import { useRoute } from 'vue-router'
import { useSettingsStore } from '@renderer/stores/settings'

const route = useRoute()
const settingsStore = useSettingsStore()

const navItems = [
  {
    name: 'library',
    label: '媒体库',
    to: '/library',
    path: 'M4 5h16v4H4zM4 11h16v4H4zM4 17h10v2H4z'
  },
  {
    name: 'history',
    label: '播放历史',
    to: '/history',
    path: 'M12 3a9 9 0 1 1-8.5 6H2l3.5-3.5L9 9H6.6A7 7 0 1 0 12 5v2.2l3-2.4zM11 8h2v4.4l3 1.8-1 1.6-4-2.4z'
  },
  {
    name: 'favorite',
    label: '我的收藏',
    to: '/favorite',
    path: 'M12 20s-7-4.4-7-9.2A4 4 0 0 1 12 8a4 4 0 0 1 7 2.8C19 15.6 12 20 12 20z'
  },
  {
    name: 'iptv',
    label: '电视直播',
    to: '/iptv',
    path: 'M4 7h16v11H4zM9 7l2-3m4 3l-2-3M11 11v4l3-2z'
  },
  {
    name: 'collect',
    label: '影视点播',
    to: '/collect',
    path: 'M4 6h16v10H4zM9 20h6M12 16v4M8 9.5l3 2-3 2z'
  },
  {
    name: 'settings',
    label: '设置',
    to: '/settings',
    path: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM4 12l1.5-1 .3-1.7-1.2-1.2 1.2-1.2 1.5.8L9 7l.6-1.6h1.8L12 7l1.7-.3.8-1.5 1.4 1.2 1.4-1.2.8 1.5L20 7l-.6 1.6 1.2 1.4-1.2 1.4.3 1.6L21 12'
  }
] as const

function isActive(path: string): boolean {
  return route.path === path
}
</script>

<template>
  <aside class="sidebar">
    <nav class="sidebar__nav">
      <router-link
        v-for="item in navItems"
        :key="item.name"
        :to="item.to"
        class="sidebar__item"
        :class="{ 'sidebar__item--active': isActive(item.to) }"
      >
        <svg viewBox="0 0 24 24" width="18" height="18" class="sidebar__icon">
          <path
            :d="item.path"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        <span>{{ item.label }}</span>
      </router-link>
    </nav>

    <div class="sidebar__footer">
      <button class="sidebar__item sidebar__item--button" @click="settingsStore.toggleTheme()">
        <svg viewBox="0 0 24 24" width="18" height="18" class="sidebar__icon">
          <path
            :d="
              settingsStore.settings.theme === 'dark'
                ? 'M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z'
                : 'M12 5V3m0 18v-2m7-7h2M3 12h2m11.5-4.5l1.4-1.4M5.1 18.9l1.4-1.4m0-11l-1.4-1.4M18.9 18.9l-1.4-1.4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z'
            "
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        <span>{{ settingsStore.settings.theme === 'dark' ? '切换浅色' : '切换深色' }}</span>
      </button>
    </div>
  </aside>
</template>

<style scoped>
.sidebar {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  width: 196px;
  flex-shrink: 0;
  padding: 12px 10px;
  background: var(--surface);
  border-right: 1px solid var(--border);
}

.sidebar__nav {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.sidebar__item {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 38px;
  padding: 0 12px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-muted);
  font-size: 13.5px;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}

.sidebar__item:hover {
  background: var(--surface-2);
  color: var(--text);
}

.sidebar__item--active {
  background: var(--accent-soft);
  color: var(--accent);
}

.sidebar__item--button {
  width: 100%;
}

.sidebar__icon {
  flex-shrink: 0;
}

.sidebar__footer {
  border-top: 1px solid var(--border);
  padding-top: 8px;
}
</style>
