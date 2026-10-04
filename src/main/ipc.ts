import { BrowserWindow, dialog, ipcMain } from 'electron'
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import { promises as fs } from 'fs'
import { basename, dirname, extname, join } from 'path'
import { looksLikeM3U } from '../shared/iptv'
import type {
  MacClass,
  MacDetailResult,
  MacListQuery,
  MacListResult,
  MacPoster,
  MacResult
} from '../shared/maccms'
import { normalizeApiUrl } from '../shared/maccms'
import type { EpgFetchResult, PlaylistFetchResult } from '../shared/xmltv'
import { VIDEO_EXTENSIONS, type MediaCapabilities, type PrepareResult } from '../shared/media'
import { SUBTITLE_EXTENSIONS, pickSidecarSubtitles, type SubtitleFileInfo } from '../shared/subtitle'
import { fetchEpg } from './epg'
import { fetchDetail, fetchList, fetchPics } from './maccms'
import { resolveBinary } from './media/binaries'
import {
  cancelPrepare,
  clearMediaCache,
  mediaCacheSize,
  prepareFile,
  probeFile,
  type PrepareOptions
} from './media/ffmpeg'
import { fetchText } from './net/http'
import { resolveStreamSource, type StreamResolveResult } from './stream'

export interface MediaFileInfo {
  path: string
  name: string
  ext: string
  size: number
  mtime: number
}

export interface PathInfo {
  path: string
  isDirectory: boolean
  exists: boolean
}

const VIDEO_SET = new Set(VIDEO_EXTENSIONS.map((e) => `.${e}`))

function windowOf(event: IpcMainEvent | IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender)
}

function toMediaFile(fullPath: string, stat: { size: number; mtimeMs: number }): MediaFileInfo {
  const ext = extname(fullPath).toLowerCase()
  return {
    path: fullPath,
    name: basename(fullPath, ext),
    ext: ext.slice(1),
    size: stat.size,
    mtime: stat.mtimeMs
  }
}

async function scanVideos(dir: string, maxDepth = 6): Promise<MediaFileInfo[]> {
  const results: MediaFileInfo[] = []

  async function walk(current: string, depth: number): Promise<void> {
    if (depth > maxDepth) return
    let entries
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const fullPath = join(current, entry.name)
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
        await walk(fullPath, depth + 1)
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase()
        if (!VIDEO_SET.has(ext)) continue
        try {
          const stat = await fs.stat(fullPath)
          results.push(toMediaFile(fullPath, stat))
        } catch {
          // 单个文件读取失败时跳过，不影响整体扫描
        }
      }
    }
  }

  await walk(dir, 0)
  return results
}

export function registerIpc(): void {
  ipcMain.on('window:minimize', (event) => windowOf(event)?.minimize())

  ipcMain.on('window:maximize', (event) => {
    const win = windowOf(event)
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })

  ipcMain.on('window:close', (event) => windowOf(event)?.close())

  ipcMain.on('window:toggle-fullscreen', (event) => {
    const win = windowOf(event)
    if (!win) return
    win.setFullScreen(!win.isFullScreen())
  })

  ipcMain.handle('window:is-maximized', (event) => windowOf(event)?.isMaximized() ?? false)

  // 窗口的原生底色与主题保持一致：浅色主题下缩放 / 还原时不会闪出一块深色
  ipcMain.on('window:set-background', (event, color: unknown) => {
    if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) return
    const win = windowOf(event)
    if (!win || win.isDestroyed()) return
    try {
      win.setBackgroundColor(color)
    } catch {
      /* 个别平台不支持动态改底色，忽略即可 */
    }
  })

  ipcMain.handle('dialog:open-files', async (event) => {
    const win = windowOf(event)
    if (!win) return []
    const result = await dialog.showOpenDialog(win, {
      title: '选择视频文件',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '视频文件', extensions: VIDEO_EXTENSIONS },
        { name: '全部文件', extensions: ['*'] }
      ]
    })
    return result.canceled ? [] : result.filePaths
  })

  ipcMain.handle('dialog:open-folder', async (event) => {
    const win = windowOf(event)
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: '选择媒体目录',
      properties: ['openDirectory']
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('dialog:open-subtitle', async (event) => {
    const win = windowOf(event)
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: '选择字幕文件',
      properties: ['openFile'],
      filters: [
        { name: '字幕文件', extensions: SUBTITLE_EXTENSIONS },
        { name: '全部文件', extensions: ['*'] }
      ]
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('dialog:open-playlist', async (event) => {
    const win = windowOf(event)
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: '选择 M3U 播放列表',
      properties: ['openFile'],
      filters: [
        { name: '播放列表', extensions: ['m3u', 'm3u8', 'txt'] },
        { name: '全部文件', extensions: ['*'] }
      ]
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('fs:scan-videos', async (_event, dir: string) => {
    if (typeof dir !== 'string' || !dir) return []
    return scanVideos(dir)
  })

  ipcMain.handle('fs:read-text', async (_event, filePath: string) => {
    return fs.readFile(filePath, 'utf-8')
  })

  /**
   * 找出与视频同目录的字幕文件（含精确同名与其他同目录候选，同名的排在前面）。
   *
   * 读目录失败（路径不存在、权限不足）时安静地返回空数组 ——
   * 「没找到字幕」是正常情况，不该让播放页弹错误。
   */
  ipcMain.handle('fs:subtitles', async (_event, videoPath: unknown): Promise<SubtitleFileInfo[]> => {
    if (typeof videoPath !== 'string' || !videoPath) return []
    const dir = dirname(videoPath)
    const allowed = new Set(SUBTITLE_EXTENSIONS.map((ext) => `.${ext}`))

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true })
      const candidates = entries
        .filter((entry) => entry.isFile() && allowed.has(extname(entry.name).toLowerCase()))
        .map((entry) => join(dir, entry.name))

      return pickSidecarSubtitles(videoPath, candidates.map((path) => ({ path }))).map((item) => ({
        path: item.path,
        name: basename(item.path),
        ext: extname(item.path).slice(1).toLowerCase(),
        exact: item.exact
      }))
    } catch {
      return []
    }
  })

  ipcMain.handle('fs:stat', async (_event, filePath: string) => {
    try {
      const stat = await fs.stat(filePath)
      return { size: stat.size, mtime: stat.mtimeMs }
    } catch {
      return null
    }
  })

  /** 拖拽落地时判断每个路径是文件还是目录 */
  ipcMain.handle('fs:classify', async (_event, paths: unknown): Promise<PathInfo[]> => {
    if (!Array.isArray(paths)) return []
    const result: PathInfo[] = []
    for (const item of paths) {
      if (typeof item !== 'string' || !item) continue
      try {
        const stat = await fs.stat(item)
        result.push({ path: item, isDirectory: stat.isDirectory(), exists: true })
      } catch {
        result.push({ path: item, isDirectory: false, exists: false })
      }
    }
    return result
  })

  /* ------------------------- 媒体能力 / 探测 / 转换 ------------------------- */

  ipcMain.handle('media:capabilities', (): MediaCapabilities => ({
    ffmpeg: resolveBinary('ffmpeg') !== null,
    ffprobe: resolveBinary('ffprobe') !== null
  }))

  ipcMain.handle('media:probe', async (_event, filePath: string) => {
    if (typeof filePath !== 'string' || !filePath) {
      return {
        ok: false,
        container: '',
        videoCodec: '',
        audioCodec: '',
        duration: 0,
        width: 0,
        height: 0,
        strategy: 'unsupported' as const,
        message: '无效的文件路径'
      }
    }
    return probeFile(filePath)
  })

  ipcMain.handle(
    'media:prepare',
    async (event, filePath: string, options?: PrepareOptions): Promise<PrepareResult> => {
      if (typeof filePath !== 'string' || !filePath) {
        return { ok: false, path: '', cached: false, strategy: 'unsupported', message: '无效的文件路径' }
      }
      const win = windowOf(event)
      return prepareFile(filePath, options ?? {}, (progress) => {
        if (win && !win.isDestroyed()) win.webContents.send('media:prepare-progress', progress)
      })
    }
  )

  ipcMain.handle('media:cancel', (_event, filePath: string) =>
    typeof filePath === 'string' ? cancelPrepare(filePath) : false
  )

  ipcMain.handle('media:cache-size', () => mediaCacheSize())

  ipcMain.handle('media:clear-cache', () => clearMediaCache())

  /* --------------------------- 苹果CMS 采集 --------------------------- */

  ipcMain.handle(
    'collect:test',
    async (
      _event,
      apiUrl: unknown
    ): Promise<MacResult<{ classes: MacClass[]; total: number; pageCount: number }>> => {
      if (typeof apiUrl !== 'string' || !normalizeApiUrl(apiUrl)) {
        return { ok: false, error: '请填写采集接口地址' }
      }
      const result = await fetchList(apiUrl, { page: 1 })
      if (!result.ok || !result.data) return { ok: false, error: result.error ?? '接口不可用' }
      return {
        ok: true,
        data: {
          classes: result.data.classes,
          total: result.data.total,
          pageCount: result.data.pageCount
        }
      }
    }
  )

  ipcMain.handle(
    'collect:list',
    async (_event, apiUrl: unknown, query: unknown): Promise<MacResult<MacListResult>> => {
      if (typeof apiUrl !== 'string' || !normalizeApiUrl(apiUrl)) {
        return { ok: false, error: '请填写采集接口地址' }
      }
      const safe: MacListQuery = {}
      if (query && typeof query === 'object') {
        const raw = query as Record<string, unknown>
        if (typeof raw.typeId === 'string') safe.typeId = raw.typeId
        if (typeof raw.keyword === 'string') safe.keyword = raw.keyword
        if (typeof raw.page === 'number' && Number.isFinite(raw.page)) safe.page = raw.page
        if (typeof raw.hours === 'number' && Number.isFinite(raw.hours)) safe.hours = raw.hours
      }
      return fetchList(apiUrl, safe)
    }
  )

  ipcMain.handle(
    'collect:detail',
    async (_event, apiUrl: unknown, vodId: unknown): Promise<MacResult<MacDetailResult>> => {
      if (typeof apiUrl !== 'string' || !normalizeApiUrl(apiUrl)) {
        return { ok: false, error: '请填写采集接口地址' }
      }
      if (typeof vodId !== 'string' || !vodId) return { ok: false, error: '缺少影片 id' }
      return fetchDetail(apiUrl, vodId)
    }
  )

  ipcMain.handle(
    'collect:pics',
    async (_event, apiUrl: unknown, ids: unknown): Promise<MacResult<MacPoster[]>> => {
      if (typeof apiUrl !== 'string' || !normalizeApiUrl(apiUrl)) {
        return { ok: false, error: '请填写采集接口地址' }
      }
      if (!Array.isArray(ids)) return { ok: false, error: '缺少影片 id' }
      const clean = ids.filter((id): id is string => typeof id === 'string' && !!id.trim())
      if (!clean.length) return { ok: true, data: [] }
      return fetchPics(apiUrl, clean)
    }
  )

  /* ------------------------------ IPTV ------------------------------ */

  ipcMain.handle('live:playlist', async (_event, url: unknown): Promise<PlaylistFetchResult> => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url.trim())) {
      return { ok: false, content: '', error: '请填写 http/https 订阅地址' }
    }
    const response = await fetchText(url.trim(), {
      timeout: 25000,
      accept: 'application/vnd.apple.mpegurl, application/x-mpegURL, audio/mpegurl, text/plain, */*'
    })
    if (!response.ok) return { ok: false, content: '', error: response.error || '下载播放列表失败' }
    if (!response.text.trim()) return { ok: false, content: '', error: '订阅地址返回了空内容' }
    if (!looksLikeM3U(response.text) && !/^[^#\s].*:\/\//m.test(response.text)) {
      return { ok: false, content: '', error: '该地址返回的不是 M3U 播放列表' }
    }
    return { ok: true, content: response.text, error: '' }
  })

  ipcMain.handle('epg:fetch', async (_event, url: unknown): Promise<EpgFetchResult> => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url.trim())) {
      return { ok: false, error: '请填写节目单地址', programmeCount: 0, channelCount: 0, bytes: 0 }
    }
    return fetchEpg(url.trim())
  })

  /* ---------------------------- 播放地址解析 ---------------------------- */

  /**
   * 有些播放地址是网页（形如 `/share/<id>`），真正的 m3u8 写在页面脚本里。
   * 渲染层拿到地址后先过这里，能解析就换成真地址，解析不了就原样返回。
   */
  ipcMain.handle('stream:resolve', async (_event, url: unknown): Promise<StreamResolveResult> => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url.trim())) {
      return { ok: false, url: '', from: 'direct', referer: '', error: '请填写 http/https 播放地址' }
    }
    return resolveStreamSource(url.trim())
  })
}
