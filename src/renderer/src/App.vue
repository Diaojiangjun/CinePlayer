<script setup lang="ts">
import { onMounted } from 'vue'
import { useRoute } from 'vue-router'
import TitleBar from '@renderer/components/TitleBar.vue'
import AppSidebar from '@renderer/components/AppSidebar.vue'
import DropOverlay from '@renderer/components/DropOverlay.vue'
import { useSettingsStore } from '@renderer/stores/settings'
import { useLibraryStore } from '@renderer/stores/library'
import { useHistoryStore } from '@renderer/stores/history'
import { useFavoriteStore } from '@renderer/stores/favorite'
import { useSourcesStore } from '@renderer/stores/sources'
import { useCollectStore } from '@renderer/stores/collect'
import { useEpgStore } from '@renderer/stores/epg'
import { cachePrune } from '@renderer/utils/cache'

const route = useRoute()

const settingsStore = useSettingsStore()
const libraryStore = useLibraryStore()
const historyStore = useHistoryStore()
const favoriteStore = useFavoriteStore()
const sourcesStore = useSourcesStore()
const collectStore = useCollectStore()
const epgStore = useEpgStore()

onMounted(async () => {
  await settingsStore.load()
  await Promise.all([
    libraryStore.load(),
    historyStore.load(),
    favoriteStore.load(),
    sourcesStore.load(),
    collectStore.loadCollections()
  ])

  // 清掉彻底过期的内容缓存；仍在有效期内的条目原样保留
  void cachePrune()

  // 订阅与节目单属于可选增强，失败不影响主流程
  void sourcesStore.refreshStale()

  // 节目单延后一点再拉：首次运行要下载并解析几十 MB 的 XMLTV，
  // 放在首屏渲染之后可以避免和界面初始化抢资源。缓存命中时这一步几乎零成本。
  if (epgStore.configured) {
    window.setTimeout(() => void epgStore.load(), 1200)
  }
})
</script>

<template>
  <div class="app-shell">
    <TitleBar />
    <div class="app-body">
      <AppSidebar v-if="route.name !== 'play'" />
      <main class="app-main" :class="{ 'app-main--full': route.name === 'play' }">
        <router-view />
      </main>
    </div>

    <!-- 全局拖拽导入：任何页面都可以把视频/文件夹拖进来 -->
    <DropOverlay />
  </div>
</template>

<style scoped>
.app-shell {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg);
}

.app-body {
  flex: 1;
  display: flex;
  min-height: 0;
}

.app-main {
  flex: 1;
  min-width: 0;
  height: 100%;
  overflow: hidden;
}

.app-main--full {
  position: relative;
}
</style>
