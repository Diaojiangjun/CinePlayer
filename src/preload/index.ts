import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  MacClass,
  MacDetailResult,
  MacListQuery,
  MacListResult,
  MacPoster,
  MacResult
} from '../shared/maccms'
import type { SubtitleFileInfo } from '../shared/subtitle'
import type { EpgFetchResult, PlaylistFetchResult } from '../shared/xmltv'

export type {
  MacClass,
  MacDetailResult,
  MacListQuery,
  MacListResult,
  MacPoster,
  MacResult,
  EpgFetchResult,
  PlaylistFetchResult,
  SubtitleFileInfo
}

export interface MediaFileInfo {
  path: string
  name: string
  ext: string
  size: number
  mtime: number
}

export interface WindowState {
  maximized: boolean
  fullscreen: boolean
}

export interface PathInfo {
  path: string
  isDirectory: boolean
  exists: boolean
}

export interface MediaProbe {
  ok: boolean
  container: string
  videoCodec: string
  audioCodec: string
  duration: number
  width: number
  height: number
  strategy: 'direct' | 'remux' | 'transcode' | 'unsupported'
  message: string
}

export interface MediaCapabilities {
  ffmpeg: boolean
  ffprobe: boolean
}

export interface PrepareProgress {
  path: string
  percent: number
  stage: 'remux' | 'transcode'
  speed: string
  state: 'running' | 'done' | 'error' | 'canceled'
  message: string
}

export interface PrepareResult {
  ok: boolean
  path: string
  cached: boolean
  strategy: MediaProbe['strategy']
  message: string
}

export interface StreamResolveResult {
  ok: boolean
  /** 最终可直接播放的地址 */
  url: string
  /** direct = 原地址本身就能播；page = 从分享页里解析出来的 */
  from: 'direct' | 'page'
  /** 分享页地址 */
  referer: string
  error: string
}

const api = {
  window: {
    minimize: (): void => ipcRenderer.send('window:minimize'),
    maximize: (): void => ipcRenderer.send('window:maximize'),
    close: (): void => ipcRenderer.send('window:close'),
    toggleFullscreen: (): void => ipcRenderer.send('window:toggle-fullscreen'),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke('window:is-maximized'),
    /** 同步原生窗口底色，避免浅色主题下缩放窗口时闪出深色底 */
    setBackground: (color: string): void => ipcRenderer.send('window:set-background', color),
    onState: (callback: (state: WindowState) => void): (() => void) => {
      const listener = (_event: unknown, state: WindowState): void => callback(state)
      ipcRenderer.on('window:state', listener)
      return () => ipcRenderer.removeListener('window:state', listener)
    }
  },
  dialog: {
    openFiles: (): Promise<string[]> => ipcRenderer.invoke('dialog:open-files'),
    openFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:open-folder'),
    openPlaylist: (): Promise<string | null> => ipcRenderer.invoke('dialog:open-playlist'),
    openSubtitle: (): Promise<string | null> => ipcRenderer.invoke('dialog:open-subtitle')
  },
  fs: {
    scanVideos: (dir: string): Promise<MediaFileInfo[]> => ipcRenderer.invoke('fs:scan-videos', dir),
    readText: (filePath: string): Promise<string> => ipcRenderer.invoke('fs:read-text', filePath),
    /** 扫描视频同目录的字幕文件（同名的排在前面） */
    subtitles: (videoPath: string): Promise<SubtitleFileInfo[]> =>
      ipcRenderer.invoke('fs:subtitles', videoPath),
    stat: (filePath: string): Promise<{ size: number; mtime: number } | null> =>
      ipcRenderer.invoke('fs:stat', filePath),
    classify: (paths: string[]): Promise<PathInfo[]> => ipcRenderer.invoke('fs:classify', paths)
  },
  media: {
    capabilities: (): Promise<MediaCapabilities> => ipcRenderer.invoke('media:capabilities'),
    probe: (filePath: string): Promise<MediaProbe> => ipcRenderer.invoke('media:probe', filePath),
    prepare: (filePath: string, options?: { forceTranscode?: boolean }): Promise<PrepareResult> =>
      ipcRenderer.invoke('media:prepare', filePath, options),
    cancel: (filePath: string): Promise<boolean> => ipcRenderer.invoke('media:cancel', filePath),
    cacheSize: (): Promise<number> => ipcRenderer.invoke('media:cache-size'),
    clearCache: (): Promise<number> => ipcRenderer.invoke('media:clear-cache'),
    onProgress: (callback: (progress: PrepareProgress) => void): (() => void) => {
      const listener = (_event: unknown, progress: PrepareProgress): void => callback(progress)
      ipcRenderer.on('media:prepare-progress', listener)
      return () => ipcRenderer.removeListener('media:prepare-progress', listener)
    }
  },
  collect: {
    /** 校验采集接口可用性，并取回分类树 */
    test: (
      apiUrl: string
    ): Promise<MacResult<{ classes: MacClass[]; total: number; pageCount: number }>> =>
      ipcRenderer.invoke('collect:test', apiUrl),
    list: (apiUrl: string, query: MacListQuery = {}): Promise<MacResult<MacListResult>> =>
      ipcRenderer.invoke('collect:list', apiUrl, query),
    detail: (apiUrl: string, vodId: string): Promise<MacResult<MacDetailResult>> =>
      ipcRenderer.invoke('collect:detail', apiUrl, vodId),
    /** 列表接口不带封面时，按 id 批量补一次（一次请求取回整页） */
    pics: (apiUrl: string, ids: string[]): Promise<MacResult<MacPoster[]>> =>
      ipcRenderer.invoke('collect:pics', apiUrl, ids)
  },
  live: {
    /** 拉取远程 M3U 订阅内容 */
    fetchPlaylist: (url: string): Promise<PlaylistFetchResult> =>
      ipcRenderer.invoke('live:playlist', url)
  },
  stream: {
    /**
     * 解析播放地址。
     * 有些地址是网页（`/share/<id>`），真正的 m3u8 写在页面脚本里 ——
     * 这里换成真正可播的地址；本来就是媒体地址时原样返回。
     */
    resolve: (url: string): Promise<StreamResolveResult> =>
      ipcRenderer.invoke('stream:resolve', url)
  },
  epg: {
    /** 拉取并解析 XMLTV 节目单 */
    fetch: (url: string): Promise<EpgFetchResult> => ipcRenderer.invoke('epg:fetch', url)
  },
  drop: {
    /** 把拖入的 File 解析成磁盘绝对路径（目录同样适用） */
    pathForFile: (file: File): string => {
      try {
        return webUtils.getPathForFile(file)
      } catch {
        return ''
      }
    }
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
