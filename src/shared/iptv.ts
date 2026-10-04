/**
 * IPTV / M3U 播放列表解析（三端共享）。
 *
 * 在标准 #EXTINF 基础上兼容 IPTV 生态里常见的扩展：
 * tvg-id / tvg-name / tvg-logo / group-title / #EXTGRP / #EXTVLCOPT / #KODIPROP。
 */

export interface IptvChannel {
  name: string
  url: string
  logo?: string
  group?: string
  /** 对应 EPG 中的 channel id */
  tvgId?: string
  tvgName?: string
}

/** 兼容旧命名 */
export type ParsedChannel = IptvChannel

const ATTR_RE = /([\w-]+)\s*=\s*"([^"]*)"/g

function readAttrs(line: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  ATTR_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = ATTR_RE.exec(line)) !== null) {
    attrs[match[1].toLowerCase()] = match[2]
  }
  return attrs
}

/**
 * 解析 M3U / M3U8 播放列表。
 * 无法识别的行会被安全跳过，不会因为个别脏数据丢失整个列表。
 */
export function parseM3U(content: string): IptvChannel[] {
  const lines = (content || '').split(/\r?\n/)
  const channels: IptvChannel[] = []
  let pending: Partial<IptvChannel> | null = null
  let pendingGroup = ''

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue

    if (line.startsWith('#EXTINF')) {
      const commaIndex = line.lastIndexOf(',')
      const attrs = readAttrs(line)
      const title = commaIndex >= 0 ? line.slice(commaIndex + 1).trim() : ''
      pending = {
        name: title || attrs['tvg-name'] || '未命名频道',
        logo: attrs['tvg-logo'] || undefined,
        group: attrs['group-title'] || pendingGroup || undefined,
        tvgId: attrs['tvg-id'] || undefined,
        tvgName: attrs['tvg-name'] || undefined
      }
      continue
    }

    if (line.startsWith('#EXTGRP')) {
      pendingGroup = line.slice(line.indexOf(':') + 1).trim()
      if (pending) pending.group = pendingGroup || pending.group
      continue
    }

    if (line.startsWith('#')) continue

    channels.push({
      name: pending?.name || line,
      url: line,
      logo: pending?.logo,
      group: pending?.group || pendingGroup || undefined,
      tvgId: pending?.tvgId,
      tvgName: pending?.tvgName
    })
    pending = null
  }

  return channels
}

/** 判断内容是否像一份 M3U 播放列表（用于拖拽/粘贴时的自动识别） */
export function looksLikeM3U(content: string): boolean {
  return /^\s*#EXTM3U/m.test(content)
}

/** 分组统计，按名称排序，空分组统一归到「未分组」 */
export function groupStats(channels: IptvChannel[]): { name: string; count: number }[] {
  const map = new Map<string, number>()
  for (const channel of channels) {
    const key = channel.group?.trim() || '未分组'
    map.set(key, (map.get(key) ?? 0) + 1)
  }
  return Array.from(map.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => {
      if (a.name === '未分组') return 1
      if (b.name === '未分组') return -1
      return a.name.localeCompare(b.name, 'zh-Hans-CN')
    })
}
