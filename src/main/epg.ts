import { parseXmltv, type EpgFetchResult } from '../shared/xmltv'
import { fetchBuffer } from './net/http'

/**
 * EPG（XMLTV）下载与解压，解析逻辑复用 shared/xmltv.ts。
 * IPTV 生态里 .xml.gz 是最常见的分发格式，这里按魔数自动识别并解压。
 */

export type EpgResult = EpgFetchResult

export async function fetchEpg(xmltvUrl: string, timeout = 30000): Promise<EpgResult> {
  const url = (xmltvUrl || '').trim()
  if (!url) {
    return { ok: false, error: '未配置节目单地址', programmeCount: 0, channelCount: 0, bytes: 0 }
  }

  const response = await fetchBuffer(url, { timeout })
  if (!response.ok) {
    return {
      ok: false,
      error: response.error || '下载节目单失败',
      programmeCount: 0,
      channelCount: 0,
      bytes: 0
    }
  }

  let buffer = response.data
  const bytes = buffer.length

  if (buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
    try {
      // EPG 压缩包体积可达数十 MB，解压放在主进程避免阻塞渲染层
      const { gunzipSync } = await import('zlib')
      buffer = gunzipSync(buffer)
    } catch {
      return { ok: false, error: '节目单压缩包解压失败', programmeCount: 0, channelCount: 0, bytes }
    }
  }

  const text = buffer.toString('utf-8')
  if (!/<tv\b/i.test(text)) {
    return {
      ok: false,
      error: '返回内容不是 XMLTV 格式的节目单',
      programmeCount: 0,
      channelCount: 0,
      bytes
    }
  }

  try {
    const data = parseXmltv(text)
    const programmeCount = Object.values(data.programmes).reduce((sum, list) => sum + list.length, 0)
    return { ok: true, data, programmeCount, channelCount: Object.keys(data.channels).length, bytes }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : '节目单解析失败',
      programmeCount: 0,
      channelCount: 0,
      bytes
    }
  }
}
