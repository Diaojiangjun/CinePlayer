import { defineStore } from 'pinia'
import { ref, toRaw } from 'vue'
import { db, DEFAULT_SETTINGS, ensureSettings } from '@renderer/db'
import type { AppSettings } from '@renderer/db/types'

/**
 * 摊平成可结构化克隆的普通对象。
 *
 * `ref()` 会把对象**深度**包成 Proxy，而 IndexedDB 的结构化克隆不支持 Proxy ——
 * `{ ...settings.value }` 只摊平了顶层，`scanFolders` 这类数组字段依然是 Proxy，
 * 写库时会抛 `DataCloneError: [object Array] could not be cloned`。
 * 设置项全部是 JSON 安全的基本类型，深拷贝一次即可彻底去 Proxy 化。
 */
function toPlain(value: AppSettings): AppSettings {
  return JSON.parse(JSON.stringify(value)) as AppSettings
}

/** 与 styles/main.css 的 --bg 保持一致，供原生窗口底色使用 */
const WINDOW_BACKGROUND: Record<AppSettings['theme'], string> = {
  dark: '#0f1115',
  light: '#f4f5f7'
}

export const useSettingsStore = defineStore('settings', () => {
  const settings = ref<AppSettings>({ ...DEFAULT_SETTINGS })
  const ready = ref(false)

  function applyTheme(): void {
    const theme = settings.value.theme === 'light' ? 'light' : 'dark'
    document.documentElement.dataset.theme = theme
    // CSS 只改得动渲染层；窗口自己的底色是主进程管的，
    // 不同步的话浅色主题下缩放 / 还原窗口会闪出一块深色。
    window.api?.window?.setBackground(WINDOW_BACKGROUND[theme])
  }

  async function load(): Promise<void> {
    settings.value = await ensureSettings()
    applyTheme()
    ready.value = true
  }

  async function update(patch: Partial<AppSettings>): Promise<void> {
    const next = toPlain({ ...toRaw(settings.value), ...patch, id: 1 } as AppSettings)
    settings.value = next

    // 先把主题刷到 DOM 上，再落盘。
    // 顺序很重要：写库是副作用，一旦它抛异常（磁盘配额、隐私模式等），
    // 排在后面的界面更新就永远不会执行 —— 表现就是「点了按钮界面毫无反应」。
    applyTheme()

    try {
      await db.settings.put(next)
    } catch (error) {
      console.warn('[settings] 保存失败，本次改动只在当前运行内生效', error)
    }
  }

  async function toggleTheme(): Promise<void> {
    await update({ theme: settings.value.theme === 'dark' ? 'light' : 'dark' })
  }

  async function addScanFolder(folder: string): Promise<void> {
    if (!folder || settings.value.scanFolders.includes(folder)) return
    await update({ scanFolders: [...settings.value.scanFolders, folder] })
  }

  async function removeScanFolder(folder: string): Promise<void> {
    await update({ scanFolders: settings.value.scanFolders.filter((f) => f !== folder) })
  }

  return {
    settings,
    ready,
    load,
    update,
    toggleTheme,
    applyTheme,
    addScanFolder,
    removeScanFolder
  }
})
