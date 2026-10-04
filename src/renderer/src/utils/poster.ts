/**
 * 封面渲染的小工具。
 *
 * 采集站的封面有两个现实问题：
 *   1. 列表接口（`ac=list`）常常压根不返回 `vod_pic`；
 *   2. 图床整片挂掉或被防盗链拦掉，`<img>` 只会留一个破图标。
 * 前者在 store 里按 id 批量补齐，后者在这里回落成按片名生成的渐变占位 ——
 * 破图标比没有封面更难看。
 */

/** 用片名算一个稳定的色相，保证同一部影片每次渲染颜色一致 */
function hueOf(text: string): number {
  let hue = 0
  for (let i = 0; i < text.length; i++) hue = (hue * 31 + text.charCodeAt(i)) % 360
  return hue
}

/** 封面缺失或加载失败时的渐变背景 */
export function posterGradient(title: string): Record<string, string> {
  const hue = hueOf(title || 'x')
  return {
    background: `linear-gradient(150deg, hsl(${hue} 46% 30%), hsl(${(hue + 40) % 360} 42% 18%))`
  }
}

/**
 * 图片加载失败时清掉地址，让卡片回落到渐变占位。
 *
 * 直接改传入的对象而不是另记一个失败集合：卡片渲染用的就是响应式代理里的同一个对象，
 * 写它必然触发重渲染；同时这份数据也是被缓存的那份，等于顺手记住「这个封面不能用」，
 * 不会每次进页面都再撞一次坏链。
 */
export function dropBrokenPoster(target: { pic?: string }): void {
  target.pic = ''
}
