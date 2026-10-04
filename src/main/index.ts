import { app, BrowserWindow, globalShortcut, session, shell } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerIpc } from './ipc'
import { killAllPreparations } from './media/ffmpeg'
import { registerMediaProtocol, registerMediaScheme } from './media/protocol'
import { refererFor } from './stream'

let mainWindow: BrowserWindow | null = null

// 自定义媒体协议必须在 app ready 之前登记为特权协议
registerMediaScheme()

/**
 * 自动播放策略：显式声明「不要求用户手势」。
 *
 * ⚠️ 实测结论（别再被直觉带偏）：**Electron 的默认值本来就是这个**，
 * 所以自动播放失败**不是**策略问题。这里显式写出来，是为了：
 *   ① 不依赖上游默认值 —— 一旦 Electron / Chromium 改了默认，行为不会悄悄变；
 *   ② 让「本应用允许无手势自动播放」成为代码里可读的事实，而不是一个隐含假设。
 *
 * 反向验证（可复现）：把策略改成 `document-user-activation-required` 后，
 * `scripts/smoke-stream.mjs` 里的自动播放用例会稳定翻红 —— 说明那条用例确实
 * 卡在策略上，而不是「怎么写都过」。命令行开关必须在 app ready 之前生效；
 * 窗口的 `webPreferences.autoplayPolicy` 是同一件事的第二处声明。
 */
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    show: false,
    frame: false,
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // 见文件顶部：显式声明，不依赖 Electron 的默认值
      autoplayPolicy: 'no-user-gesture-required'
    }
  })

  const emitState = (): void => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.webContents.send('window:state', {
      maximized: mainWindow.isMaximized(),
      fullscreen: mainWindow.isFullScreen()
    })
  }

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('maximize', emitState)
  mainWindow.on('unmaximize', emitState)
  mainWindow.on('enter-full-screen', emitState)
  mainWindow.on('leave-full-screen', emitState)
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // 拖入视频时 Chromium 默认会直接导航到该文件，这里拦下来交给渲染层处理
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const current = mainWindow?.webContents.getURL() ?? ''
    if (url === current || url.startsWith(current.split('#')[0] + '#')) return
    event.preventDefault()
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    electronApp.setAppUserModelId('com.cineplayer.app')
    app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

    // IPTV / 采集站点的流地址与 HLS 分片基本都不带 CORS 响应头，
    // 渲染层的 hls.js 与 <video> 会被浏览器同源策略拦下。
    // 这里统一为 http(s) 响应补上跨域头，让播放内核能直接拉流。
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      const headers: Record<string, string[]> = { ...(details.responseHeaders ?? {}) }
      for (const key of Object.keys(headers)) {
        const lower = key.toLowerCase()
        if (lower === 'access-control-allow-origin' || lower === 'access-control-allow-headers') {
          delete headers[key]
        }
      }
      headers['Access-Control-Allow-Origin'] = ['*']
      headers['Access-Control-Allow-Headers'] = ['*']
      callback({ responseHeaders: headers })
    })

    // 分享页解析出来的流通常带 Referer 防盗链（只认播放页来的请求）。
    // 渲染层的 hls.js 没有设置 Referer 的入口，只能在主进程按 origin 补上。
    // 这里**是覆盖**而不是「仅在缺失时补」：Chromium 自己也会按文档地址算出一个
    // Referer（开发模式下就是 localhost:5173），那个值对目标站点来说是错的。
    // 没登记过的 origin 一律不动，避免影响应用自身与普通站点的请求。
    session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
      const referer = refererFor(details.url)
      if (!referer) {
        callback({})
        return
      }
      const requestHeaders: Record<string, string> = { ...(details.requestHeaders ?? {}) }
      const existing = Object.keys(requestHeaders).find((key) => key.toLowerCase() === 'referer')
      if (existing && existing !== 'Referer') delete requestHeaders[existing]
      requestHeaders.Referer = referer
      callback({ requestHeaders })
    })

    registerMediaProtocol()
    registerIpc()
    createWindow()
    // 全局快捷键：聚焦 / 取消聚焦主窗口
    globalShortcut.register('Alt+Space', () => {
      if (!mainWindow) return
      if (mainWindow.isFocused()) mainWindow.blur()
      else mainWindow.focus()
    })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
    killAllPreparations()
  })
}
