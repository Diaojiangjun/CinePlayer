import { protocol } from 'electron'
import { createReadStream } from 'fs'
import { promises as fs } from 'fs'
import { Readable } from 'stream'
import { MEDIA_SCHEME, mediaUrlToPath, mimeOfPath } from '../../shared/media'

/** 协议注册必须在 app ready 之前完成 */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        bypassCSP: true,
        corsEnabled: true
      }
    }
  ])
}

function bodyOf(filePath: string, start?: number, end?: number): BodyInit {
  const stream = start === undefined ? createReadStream(filePath) : createReadStream(filePath, { start, end })
  // Readable.toWeb 返回 Node 版 ReadableStream，与 DOM 类型定义不完全一致，这里做一次显式转换
  return Readable.toWeb(stream) as unknown as BodyInit
}

function parseRange(header: string, total: number): { start: number; end: number } | null {
  const match = /bytes=(\d*)-(\d*)/i.exec(header)
  if (!match) return null

  let start = match[1] ? Number(match[1]) : 0
  let end = match[2] ? Number(match[2]) : total - 1

  if (!Number.isFinite(start) || start < 0) start = 0
  if (!Number.isFinite(end) || end >= total) end = total - 1
  if (start > end) return null
  return { start, end }
}

/**
 * 处理 cine-file://local/<base64url(path)> 请求：
 * - 支持 Range，播放器可精确 seek（Chromium 对 <video> 会发 206 分段请求）
 * - 按扩展名返回正确的 Content-Type，帮助 Chromium 选择解复用器
 */
export function registerMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    const filePath = mediaUrlToPath(request.url)
    if (!filePath) return new Response('Bad Request', { status: 400 })

    let stat
    try {
      stat = await fs.stat(filePath)
    } catch {
      return new Response('Not Found', { status: 404 })
    }
    if (!stat.isFile()) return new Response('Not Found', { status: 404 })

    const total = stat.size
    const mime = mimeOfPath(filePath)
    const rangeHeader = request.headers.get('Range')

    if (rangeHeader) {
      const range = parseRange(rangeHeader, total)
      if (!range) {
        return new Response(null, {
          status: 416,
          headers: { 'Content-Range': `bytes */${total}`, 'Accept-Ranges': 'bytes' }
        })
      }
      const length = range.end - range.start + 1
      return new Response(bodyOf(filePath, range.start, range.end), {
        status: 206,
        headers: {
          'Content-Type': mime,
          'Content-Length': String(length),
          'Content-Range': `bytes ${range.start}-${range.end}/${total}`,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-cache'
        }
      })
    }

    return new Response(bodyOf(filePath), {
      status: 200,
      headers: {
        'Content-Type': mime,
        'Content-Length': String(total),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache'
      }
    })
  })
}
