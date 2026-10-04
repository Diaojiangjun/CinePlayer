<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

const api = window.api
const maximized = ref(false)
let dispose: (() => void) | undefined

onMounted(async () => {
  maximized.value = await api.window.isMaximized()
  dispose = api.window.onState((state) => {
    maximized.value = state.maximized
  })
})

onBeforeUnmount(() => dispose?.())
</script>

<template>
  <header class="titlebar drag-region">
    <div class="titlebar__brand">
      <span class="titlebar__logo" aria-hidden="true"></span>
      <span class="titlebar__name">CinePlayer</span>
    </div>

    <div class="titlebar__controls no-drag">
      <button class="titlebar__btn" title="最小化" @click="api.window.minimize()">
        <svg viewBox="0 0 12 12" width="12" height="12">
          <path d="M2 6h8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
        </svg>
      </button>
      <button
        class="titlebar__btn"
        :title="maximized ? '还原' : '最大化'"
        @click="api.window.maximize()"
      >
        <svg viewBox="0 0 12 12" width="12" height="12">
          <rect
            v-if="!maximized"
            x="2.5"
            y="2.5"
            width="7"
            height="7"
            rx="1"
            fill="none"
            stroke="currentColor"
            stroke-width="1.2"
          />
          <g v-else fill="none" stroke="currentColor" stroke-width="1.2">
            <rect x="2.5" y="4" width="5.5" height="5.5" rx="1" />
            <path d="M4.5 4V3.2A1 1 0 0 1 5.5 2.2h3.3a1 1 0 0 1 1 1v3.3a1 1 0 0 1-1 1H8" />
          </g>
        </svg>
      </button>
      <button class="titlebar__btn titlebar__btn--close" title="关闭" @click="api.window.close()">
        <svg viewBox="0 0 12 12" width="12" height="12">
          <path
            d="M3 3l6 6M9 3l-6 6"
            stroke="currentColor"
            stroke-width="1.2"
            stroke-linecap="round"
          />
        </svg>
      </button>
    </div>
  </header>
</template>

<style scoped>
.titlebar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 40px;
  padding: 0 10px 0 14px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  user-select: none;
  flex-shrink: 0;
}

.titlebar__brand {
  display: flex;
  align-items: center;
  gap: 8px;
}

.titlebar__logo {
  width: 14px;
  height: 14px;
  border-radius: 4px;
  background: linear-gradient(135deg, var(--accent), #7c5cff);
}

.titlebar__name {
  font-size: 13px;
  color: var(--text-muted);
  letter-spacing: 0.02em;
}

.titlebar__controls {
  display: flex;
  align-items: center;
}

.titlebar__btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 28px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}

.titlebar__btn:hover {
  background: var(--surface-2);
  color: var(--text);
}

.titlebar__btn--close:hover {
  background: var(--danger);
  color: #fff;
}
</style>
