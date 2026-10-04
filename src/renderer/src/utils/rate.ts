/**
 * 网络速率计量。
 *
 * 播放器拿到的其实是**一次次离散的采样**（一片分片、一次请求），
 * 直接显示瞬时值会疯狂跳动；所以这里做两件事：
 *   1. 指数滑动平均（EMA）压平抖动；
 *   2. 一段时间没有新数据就线性衰减到 0 —— 否则卡住不动时界面还挂着「3 MB/s」，
 *      那是误导。
 */
export interface RateMeter {
  /** 记录一次采样：bytes 字节用了 ms 毫秒 */
  push(bytes: number, ms: number): void
  /** 读当前速率（字节/秒）；数据停流后会自行衰减 */
  read(): number
  reset(): void
}

export function createRateMeter(options: { alpha?: number; staleMs?: number } = {}): RateMeter {
  const alpha = options.alpha ?? 0.35
  const staleMs = options.staleMs ?? 1200
  let speed = 0
  let lastAt = 0

  return {
    push(bytes, ms) {
      if (!Number.isFinite(bytes) || !Number.isFinite(ms)) return
      if (bytes <= 0 || ms <= 0) return
      const sample = (bytes * 1000) / ms
      if (!Number.isFinite(sample) || sample <= 0) return
      speed = speed > 0 ? speed * (1 - alpha) + sample * alpha : sample
      lastAt = performance.now()
    },
    read() {
      if (speed <= 0) return 0
      const idle = performance.now() - lastAt
      if (idle <= staleMs) return speed
      // 超出宽限期仍在停流：按同等时长线性衰减，避免读数「僵尸化」
      const decay = 1 - (idle - staleMs) / staleMs
      return decay > 0 ? speed * decay : 0
    },
    reset() {
      speed = 0
      lastAt = 0
    }
  }
}

/** 1480 → `1.4 KB/s`；1480000 → `1.4 MB/s` */
export function formatSpeed(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return ''
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s']
  const index = Math.min(Math.floor(Math.log(bytesPerSecond) / Math.log(1024)), units.length - 1)
  const value = bytesPerSecond / Math.pow(1024, index)
  // 999 以上再带小数就没有意义了
  const digits = index === 0 || value >= 100 ? 0 : 1
  return `${value.toFixed(digits)} ${units[index]}`
}
