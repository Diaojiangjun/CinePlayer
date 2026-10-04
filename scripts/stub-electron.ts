/**
 * 验证用 Electron 桩：把 net.request 替换成本地夹具，
 * 让主进程的采集 / EPG 客户端可以脱离 Electron 与真实网络运行。
 */
import { EventEmitter } from 'events'

interface Fixture {
  status: number
  body: Buffer
  headers: Record<string, string>
}

const fixtures = new Map<string, Fixture>()
/** 记录被真正请求过的地址，便于断言「这一步不该发请求」 */
const requested: string[] = []

export function $mock(
  url: string,
  body: Buffer | string,
  status = 200,
  headers: Record<string, string> = {}
): void {
  fixtures.set(url, {
    status,
    body: Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf-8'),
    headers
  })
}

export function $reset(): void {
  fixtures.clear()
  requested.length = 0
}

/** 本次 $reset 之后被请求过的地址 */
export function $requested(): string[] {
  return [...requested]
}

class FakeResponse extends EventEmitter {
  statusCode = 200
  headers: Record<string, string> = {}
}

interface FakeRequest extends EventEmitter {
  setHeader: (name: string, value: string) => void
  abort: () => void
  end: () => void
}

export const net = {
  request(options: { url: string }): FakeRequest {
    const request = new EventEmitter() as FakeRequest
    request.setHeader = () => undefined
    request.abort = () => undefined
    request.end = () => {
      setImmediate(() => {
        requested.push(options.url)
        const fixture = fixtures.get(options.url)
        if (!fixture) {
          request.emit('error', new Error('net::ERR_NAME_NOT_RESOLVED'))
          return
        }
        const response = new FakeResponse()
        response.statusCode = fixture.status
        response.headers = fixture.headers
        request.emit('response', response)
        setImmediate(() => {
          response.emit('data', fixture.body)
          response.emit('end')
        })
      })
    }
    return request
  }
}
