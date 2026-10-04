import { ElectronAPI } from '@electron-toolkit/preload'
import type { MediaCapabilities, MediaProbe, PrepareProgress, PrepareResult } from '../shared/media'
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

export interface CineApi {
  window: {
    minimize: () => void
    maximize: () => void
    close: () => void
    toggleFullscreen: () => void
    isMaximized: () => Promise<boolean>
    setBackground: (color: string) => void
    onState: (callback: (state: WindowState) => void) => () => void
  }
  dialog: {
    openFiles: () => Promise<string[]>
    openFolder: () => Promise<string | null>
    openPlaylist: () => Promise<string | null>
    openSubtitle: () => Promise<string | null>
  }
  fs: {
    scanVideos: (dir: string) => Promise<MediaFileInfo[]>
    readText: (filePath: string) => Promise<string>
    subtitles: (videoPath: string) => Promise<SubtitleFileInfo[]>
    stat: (filePath: string) => Promise<{ size: number; mtime: number } | null>
    classify: (paths: string[]) => Promise<PathInfo[]>
  }
  media: {
    capabilities: () => Promise<MediaCapabilities>
    probe: (filePath: string) => Promise<MediaProbe>
    prepare: (filePath: string, options?: { forceTranscode?: boolean }) => Promise<PrepareResult>
    cancel: (filePath: string) => Promise<boolean>
    cacheSize: () => Promise<number>
    clearCache: () => Promise<number>
    onProgress: (callback: (progress: PrepareProgress) => void) => () => void
  }
  collect: {
    test: (apiUrl: string) => Promise<MacResult<{ classes: MacClass[]; total: number; pageCount: number }>>
    list: (apiUrl: string, query?: MacListQuery) => Promise<MacResult<MacListResult>>
    detail: (apiUrl: string, vodId: string) => Promise<MacResult<MacDetailResult>>
    pics: (apiUrl: string, ids: string[]) => Promise<MacResult<MacPoster[]>>
  }
  live: {
    fetchPlaylist: (url: string) => Promise<PlaylistFetchResult>
  }
  stream: {
    resolve: (url: string) => Promise<StreamResolveResult>
  }
  epg: {
    fetch: (url: string) => Promise<EpgFetchResult>
  }
  drop: {
    pathForFile: (file: File) => string
  }
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: CineApi
  }
}
