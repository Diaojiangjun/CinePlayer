import { net } from 'electron'
import type { ClientRequest } from 'electron'

/**
 * 主进程网络层。
 *
 * 采集站与 IPTV 订阅地址都不允许跨域访问，渲染进程直接 fetch 会被 CORS 拦下，
 * 因此统一走 Electron 的 net 模块：自动走系统代理、自动解压 gzip、
 * 并按响应头 / XML 声明自动选择 GBK 或 UTF-8 解码。
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

export interface TextResponse {
  ok: boolean
  status: number
  text: string
  /** 响应头里的 Content-Type，用于判断「这是个网页还是一份播放列表」 */
  contentType: string
  /** 跟随重定向之后的最终地址 —— 相对路径要按它（而不是原始地址）解析 */
  finalUrl: string
  error: string
}

export interface FetchOptions {
  timeout?: number
  referer?: string
  /** 期望的 Accept，默认同时接受 JSON 与 XML */
  accept?: string
  /**
   * 响应体上限（字节），超出即中止读取。
   * 用于「只是想看看这是不是网页」的探测 —— 不该把一整个大文件拖下来。
   */
  maxBytes?: number
}

function headerValue(headers: Record<string, string | string[]>, name: string): string {
  const found = Object.keys(headers).find((key) => key.toLowerCase() === name)
  if (!found) return ''
  const value = headers[found]
  return Array.isArray(value) ? (value[0] ?? '') : String(value ?? '')
}

function normalizeCharset(raw: string): string {
  const value = raw.trim().toLowerCase().replace(/["']/g, '')
  if (!value) return 'utf-8'
  if (value === 'gb2312' || value === 'gbk' || value === 'gb18030') return 'gbk'
  if (value === 'utf8' || value === 'utf-8') return 'utf-8'
  if (value === 'big5') return 'big5'
  return value
}

/** 依据 BOM、XML 声明或 meta 标签挑选解码字符集，中文站点常见 GBK */
function decodeBody(buffer: Buffer): string {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString('utf-8')
  }

  const head = buffer.subarray(0, 4096).toString('latin1')
  const declared =
    /<\?xml[^>]*encoding\s*=\s*["']([\w-]+)["']/i.exec(head)?.[1] ??
    /charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1] ??
    'utf-8'
  const charset = normalizeCharset(declared)

  if (charset === 'utf-8') return buffer.toString('utf-8')
  try {
    return new TextDecoder(charset).decode(buffer)
  } catch {
    return buffer.toString('utf-8')
  }
}

export function fetchText(url: string, options: FetchOptions = {}): Promise<TextResponse> {
  const timeout = options.timeout ?? 15000
  const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY

  return new Promise<TextResponse>((resolve) => {
    let settled = false
    let finalUrl = url
    let received = 0
    let overLimit = false

    const finish = (result: TextResponse): void => {
      if (settled) return
      settled = true
      resolve(result)
    }

    let request: ClientRequest
    try {
      request = net.request({ url, method: 'GET', redirect: 'follow' })
    } catch (error) {
      finish({ ok: false, status: 0, text: '', contentType: '', finalUrl: url, error: describe(error) })
      return
    }

    const timer = setTimeout(() => {
      try {
        request.abort()
      } catch {
        /* 已结束时忽略 */
      }
      finish({
        ok: false,
        status: 0,
        text: '',
        contentType: '',
        finalUrl,
        error: `请求超时（${Math.round(timeout / 1000)}s）`
      })
    }, timeout)

    const done = (result: TextResponse): void => {
      clearTimeout(timer)
      finish(result)
    }

    // 跟随重定向时记下最终落点。不同 Electron 版本的参数位置有出入，
    // 这里直接挑出第一个像 http(s) 地址的参数，避免被签名变化坑到。
    request.on('redirect', (...args: unknown[]) => {
      const target = args.find((arg) => typeof arg === 'string' && /^https?:\/\//i.test(arg))
      if (typeof target === 'string') finalUrl = target
    })

    try {
      request.setHeader('User-Agent', UA)
      request.setHeader('Accept', options.accept ?? 'application/json, text/xml, text/plain, */*')
      request.setHeader('Accept-Language', 'zh-CN,zh;q=0.9,en;q=0.8')
      if (options.referer) request.setHeader('Referer', options.referer)
    } catch {
      /* 个别环境不允许改头，忽略即可 */
    }

    request.on('response', (response) => {
      const headers = (response.headers ?? {}) as Record<string, string | string[]>
      const contentType = headerValue(headers, 'content-type')
      const chunks: Buffer[] = []

      response.on('data', (chunk: Buffer) => {
        const buffer = Buffer.from(chunk)
        received += buffer.length
        if (received > maxBytes) {
          // 超出上限：保留已读到的部分直接收工，不整份下完
          overLimit = true
          try {
            request.abort()
          } catch {
            /* 忽略 */
          }
          const text = decodeBody(Buffer.concat(chunks))
          done({ ok: true, status: response.statusCode ?? 0, text, contentType, finalUrl, error: '' })
          return
        }
        chunks.push(buffer)
      })

      response.on('end', () => {
        if (settled) return
        const status = response.statusCode ?? 0
        const text = decodeBody(Buffer.concat(chunks))
        done({
          ok: status >= 200 && status < 300,
          status,
          text,
          contentType,
          finalUrl,
          error: status >= 200 && status < 300 ? '' : `HTTP ${status}`
        })
      })
      response.on('error', (error: Error) =>
        done({ ok: false, status: 0, text: '', contentType, finalUrl, error: describe(error) })
      )
      response.on('aborted', () => {
        if (settled || overLimit) return
        done({ ok: false, status: 0, text: '', contentType, finalUrl, error: '连接被中断' })
      })
    })

    request.on('error', (error: Error) => {
      // 主动 abort 截断不算失败：已经拿到了够用的响应体
      if (overLimit) return
      done({ ok: false, status: 0, text: '', contentType: '', finalUrl, error: describe(error) })
    })
    request.end()
  })
}

/** 下载二进制（EPG 的 .xml.gz 等） */
export function fetchBuffer(
  url: string,
  options: FetchOptions = {}
): Promise<{ ok: boolean; status: number; data: Buffer; error: string }> {
  const timeout = options.timeout ?? 30000

  return new Promise((resolve) => {
    let settled = false
    const finish = (result: { ok: boolean; status: number; data: Buffer; error: string }): void => {
      if (settled) return
      settled = true
      resolve(result)
    }

    let request: ClientRequest
    try {
      request = net.request({ url, method: 'GET', redirect: 'follow' })
    } catch (error) {
      finish({ ok: false, status: 0, data: Buffer.alloc(0), error: describe(error) })
      return
    }

    const timer = setTimeout(() => {
      try {
        request.abort()
      } catch {
        /* 忽略 */
      }
      finish({ ok: false, status: 0, data: Buffer.alloc(0), error: '请求超时' })
    }, timeout)

    const done = (result: { ok: boolean; status: number; data: Buffer; error: string }): void => {
      clearTimeout(timer)
      finish(result)
    }

    try {
      request.setHeader('User-Agent', UA)
      request.setHeader('Accept', '*/*')
    } catch {
      /* 忽略 */
    }

    request.on('response', (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
      response.on('end', () => {
        const status = response.statusCode ?? 0
        done({
          ok: status >= 200 && status < 300,
          status,
          data: Buffer.concat(chunks),
          error: status >= 200 && status < 300 ? '' : `HTTP ${status}`
        })
      })
      response.on('error', (error: Error) =>
        done({ ok: false, status: 0, data: Buffer.alloc(0), error: describe(error) })
      )
    })

    request.on('error', (error: Error) =>
      done({ ok: false, status: 0, data: Buffer.alloc(0), error: describe(error) })
    )
    request.end()
  })
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    if (/ENOTFOUND|ERR_NAME_NOT_RESOLVED/i.test(error.message)) return '域名无法解析，请检查接口地址'
    if (/ECONNREFUSED|ERR_CONNECTION_REFUSED/i.test(error.message)) return '连接被拒绝，站点可能已关闭'
    if (/CERT|ERR_CERT/i.test(error.message)) return 'HTTPS 证书校验失败'
    if (/ERR_TIMED_OUT/i.test(error.message)) return '连接超时'
    return error.message
  }
  return '网络请求失败'
}
