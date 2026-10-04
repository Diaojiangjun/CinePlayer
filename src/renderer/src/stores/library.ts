import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { db } from '@renderer/db'
import type { MediaItem } from '@renderer/db/types'
import { baseNameOfPath, dirOfPath, isVideoPath } from '../../../shared/media'

function titleOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  return dot > 0 ? fileName.slice(0, dot) : fileName
}

function extOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  return dot > 0 ? fileName.slice(dot + 1).toLowerCase() : ''
}

export const useLibraryStore = defineStore('library', () => {
  const items = ref<MediaItem[]>([])
  const loading = ref(false)
  const keyword = ref('')

  const filtered = computed(() => {
    const k = keyword.value.trim().toLowerCase()
    if (!k) return items.value
    return items.value.filter(
      (i) => i.title.toLowerCase().includes(k) || i.path.toLowerCase().includes(k)
    )
  })

  const totalSize = computed(() => items.value.reduce((sum, i) => sum + i.size, 0))

  async function load(): Promise<void> {
    items.value = await db.media.orderBy('addedAt').reverse().toArray()
  }

  /**
   * 批量入库。
   *
   * 注意：所有 IPC / 文件系统读取都必须在 Dexie 事务之外完成 ——
   * 在事务里 await 一次 IPC 往返会让事务被提前提交，后续写入直接抛
   * TransactionInactiveError，之前的实现就是因此在导入时静默失败。
   */
  async function addPaths(paths: string[], folder = ''): Promise<number> {
    const now = Date.now()
    const seen = new Set<string>()
    await db.media.each((item) => seen.add(item.path))

    const targets = paths.filter((path) => {
      if (!path || seen.has(path)) return false
      seen.add(path)
      return true
    })
    if (!targets.length) return 0

    const records: MediaItem[] = []
    for (const path of targets) {
      const info = await window.api.fs.stat(path)
      const name = baseNameOfPath(path)
      records.push({
        path,
        name,
        title: titleOf(name),
        ext: extOf(name),
        size: info?.size ?? 0,
        mtime: info?.mtime ?? now,
        folder: folder || dirOfPath(path),
        addedAt: now
      })
    }

    let added = 0
    try {
      await db.media.bulkAdd(records)
      added = records.length
    } catch {
      // 并发导入触发唯一索引冲突时逐条补齐，已存在的跳过
      for (const record of records) {
        try {
          await db.media.add(record)
          added++
        } catch {
          /* 已存在 */
        }
      }
    }

    await load()
    return added
  }

  async function importFiles(): Promise<number> {
    const paths = await window.api.dialog.openFiles()
    if (!paths.length) return 0
    return addPaths(paths)
  }

  async function importFolder(): Promise<number> {
    const dir = await window.api.dialog.openFolder()
    if (!dir) return 0
    return rescanFolder(dir)
  }

  async function rescanFolder(dir: string): Promise<number> {
    loading.value = true
    try {
      const files = await window.api.fs.scanVideos(dir)
      return await addPaths(
        files.map((file) => file.path),
        dir
      )
    } finally {
      loading.value = false
    }
  }

  /** 处理拖拽落地：文件直接入库，目录递归扫描 */
  async function importPaths(rawPaths: string[]): Promise<number> {
    const cleaned = rawPaths.filter((path) => typeof path === 'string' && path.trim().length > 0)
    if (!cleaned.length) return 0

    const infos = await window.api.fs.classify(cleaned)
    const files: string[] = []
    let added = 0

    for (const info of infos) {
      if (!info.exists) continue
      if (info.isDirectory) {
        added += await rescanFolder(info.path)
      } else if (isVideoPath(info.path)) {
        files.push(info.path)
      }
    }

    if (files.length) added += await addPaths(files)
    return added
  }

  async function rename(id: number, title: string): Promise<void> {
    await db.media.update(id, { title })
    await load()
  }

  async function remove(id: number): Promise<void> {
    await db.media.delete(id)
    await load()
  }

  async function clearAll(): Promise<void> {
    await db.media.clear()
    await load()
  }

  function byId(id: number): MediaItem | undefined {
    return items.value.find((i) => i.id === id)
  }

  return {
    items,
    loading,
    keyword,
    filtered,
    totalSize,
    load,
    addPaths,
    importFiles,
    importFolder,
    importPaths,
    rescanFolder,
    rename,
    remove,
    clearAll,
    byId
  }
})
