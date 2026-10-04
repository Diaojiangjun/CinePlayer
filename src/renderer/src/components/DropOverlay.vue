<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useLibraryStore } from '@renderer/stores/library'
import { isVideoPath } from '../../../shared/media'

const router = useRouter()
const library = useLibraryStore()

const dragging = ref(false)
const busy = ref(false)
const toast = ref('')

let dragDepth = 0
let toastTimer: number | undefined

function hasFiles(event: DragEvent): boolean {
  const types = event.dataTransfer?.types
  return !!types && Array.from(types).includes('Files')
}

function onDragEnter(event: DragEvent): void {
  if (!hasFiles(event)) return
  event.preventDefault()
  dragDepth++
  dragging.value = true
}

function onDragOver(event: DragEvent): void {
  // 必须阻止默认行为，否则 Chromium 会直接导航到被拖入的文件
  event.preventDefault()
  if (!hasFiles(event)) return
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
}

function onDragLeave(event: DragEvent): void {
  if (!hasFiles(event)) return
  dragDepth = Math.max(0, dragDepth - 1)
  if (dragDepth === 0) dragging.value = false
}

function flash(text: string): void {
  toast.value = text
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => (toast.value = ''), 3200)
}

/** 从拖拽数据中还原磁盘绝对路径（Electron 的 File 对象带真实路径） */
function collectPaths(event: DragEvent): string[] {
  const transfer = event.dataTransfer
  if (!transfer) return []

  const paths: string[] = []
  for (const file of Array.from(transfer.files)) {
    const path = window.api.drop.pathForFile(file)
    if (path) paths.push(path)
  }

  if (paths.length) return paths

  const raw = transfer.getData('text/uri-list') || transfer.getData('text/plain')
  for (const line of raw.split(/\r?\n/)) {
    const value = line.trim()
    if (!value || value.startsWith('#')) continue
    if (!value.startsWith('file://')) continue
    try {
      const decoded = decodeURIComponent(new URL(value).pathname)
      paths.push(decoded.replace(/^\/([A-Za-z]:)/, '$1'))
    } catch {
      /* 忽略无法解析的条目 */
    }
  }
  return paths
}

async function onDrop(event: DragEvent): Promise<void> {
  event.preventDefault()
  dragDepth = 0
  dragging.value = false

  const paths = collectPaths(event)
  if (!paths.length) {
    flash('没有识别到可导入的文件')
    return
  }

  busy.value = true
  try {
    const added = await library.importPaths(paths)

    if (added === 0) {
      flash('这些视频已经在媒体库中，或不是支持的视频文件')
      return
    }

    flash(`已导入 ${added} 个视频`)

    // 只拖入单个视频文件时直接开播，省一次点击
    const single = paths.length === 1 && isVideoPath(paths[0])
    if (single) {
      const item = library.items.find((entry) => entry.path === paths[0])
      if (item) {
        router.push({ name: 'play', query: { path: item.path, title: item.title } })
        return
      }
    }

    if (router.currentRoute.value.name !== 'library') router.push('/library')
  } catch (error) {
    flash(`导入失败：${error instanceof Error ? error.message : '未知错误'}`)
  } finally {
    busy.value = false
  }
}

onMounted(() => {
  window.addEventListener('dragenter', onDragEnter)
  window.addEventListener('dragover', onDragOver)
  window.addEventListener('dragleave', onDragLeave)
  window.addEventListener('drop', onDrop)
})

onBeforeUnmount(() => {
  window.removeEventListener('dragenter', onDragEnter)
  window.removeEventListener('dragover', onDragOver)
  window.removeEventListener('dragleave', onDragLeave)
  window.removeEventListener('drop', onDrop)
  window.clearTimeout(toastTimer)
})
</script>

<template>
  <transition name="drop-fade">
    <div v-if="dragging" class="drop">
      <div class="drop__card">
        <svg viewBox="0 0 24 24" width="34" height="34" aria-hidden="true">
          <path
            d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
          <path
            d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            stroke-linecap="round"
          />
        </svg>
        <p class="drop__title">{{ busy ? '正在导入…' : '松开鼠标即可导入' }}</p>
        <p class="drop__hint">支持视频文件与整个文件夹（会自动递归扫描）</p>
      </div>
    </div>
  </transition>

  <transition name="drop-fade">
    <div v-if="toast" class="drop-toast">{{ toast }}</div>
  </transition>
</template>

<style scoped>
.drop {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(8, 10, 14, 0.62);
  backdrop-filter: blur(6px);
}

.drop__card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 34px 48px;
  border-radius: 18px;
  border: 1.5px dashed rgba(255, 255, 255, 0.34);
  background: rgba(255, 255, 255, 0.06);
  color: #fff;
  text-align: center;
}

.drop__title {
  margin: 8px 0 0;
  font-size: 16px;
  font-weight: 500;
}

.drop__hint {
  margin: 0;
  font-size: 12.5px;
  color: rgba(255, 255, 255, 0.66);
}

.drop-toast {
  position: fixed;
  left: 50%;
  bottom: 32px;
  z-index: 220;
  transform: translateX(-50%);
  padding: 10px 18px;
  border-radius: 10px;
  background: rgba(22, 25, 32, 0.92);
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: #fff;
  font-size: 13px;
  box-shadow: 0 12px 30px rgba(0, 0, 0, 0.35);
}

/* 同 PlayerCore：入场交给时间轴驱动的 @keyframes，
   免得拖拽遮罩卡在 `.drop-fade-enter-from` 的 opacity: 0 上当隐身人 */
@keyframes drop-fade-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

.drop-fade-enter-active {
  animation: drop-fade-in 0.18s ease;
}

.drop-fade-leave-active {
  transition: opacity 0.18s ease;
}

.drop-fade-leave-to {
  opacity: 0;
}
</style>
