/**
 * 外挂字幕解析（SRT / ASS-SSA / WebVTT）。
 *
 * 全部是纯函数：不碰 DOM、不碰 Electron，因此可以离线断言（见 `scripts/verify-parsers.ts`）。
 * 播放入口只负责把解析结果塞进 `<video>` 的 TextTrack —— 这条路径不产生任何 URL 请求，
 * 所以既不受 CSP 影响，也不用管 `file://` 跨域。
 */

export interface SubtitleCue {
  /** 起始时间（秒） */
  start: number
  /** 结束时间（秒） */
  end: number
  /** 归一化后的提示文本，可能含换行 */
  text: string
}

export type SubtitleFormat = 'srt' | 'ass' | 'vtt' | 'unknown'

/** 扫描到的字幕文件；`exact` 表示与视频同名（或同名前缀），可以安全地自动挂载 */
export interface SubtitleFileInfo {
  path: string
  name: string
  ext: string
  exact: boolean
}

/** 选择字幕文件时的扩展名白名单 */
export const SUBTITLE_EXTENSIONS = ['srt', 'ass', 'ssa', 'vtt', 'sub', 'txt']

/** ASS/SSA 事件行在没有 `Format:` 说明时的默认字段顺序 */
const ASS_FIELDS = [
  'layer',
  'start',
  'end',
  'style',
  'name',
  'marginl',
  'marginr',
  'marginv',
  'effect',
  'text'
]

const pad = (value: number, width: number): string => String(value).padStart(width, '0')

/**
 * 解析字幕时间戳，返回秒。同时吃下三种写法：
 *
 * - `00:01:02,345`（SRT，逗号毫秒）
 * - `00:01:02.345`（WebVTT）
 * - `0:00:02.34`（ASS，两位百分秒、时不补零）
 * - `01:02.345`（省略小时的 WebVTT）
 *
 * 无法解析时返回 `NaN`，调用方据此丢弃整条字幕。
 */
export function parseTimestamp(raw: string): number {
  const text = String(raw ?? '').trim().replace(',', '.')
  if (!text) return NaN

  const parts = text.split(':')
  if (parts.length > 3) return NaN

  let seconds = 0
  for (const part of parts) {
    const value = Number(part)
    if (!Number.isFinite(value) || value < 0) return NaN
    seconds = seconds * 60 + value
  }
  return seconds
}

/** 秒 → `HH:MM:SS.mmm`，用于回写 WebVTT */
export function formatCueTime(seconds: number): string {
  const value = Number.isFinite(seconds) && seconds > 0 ? seconds : 0
  const totalMs = Math.round(value * 1000)
  const ms = totalMs % 1000
  const rest = (totalMs - ms) / 1000
  return `${pad(Math.floor(rest / 3600), 2)}:${pad(Math.floor(rest / 60) % 60, 2)}:${pad(rest % 60, 2)}.${pad(ms, 3)}`
}

/**
 * 把一条字幕的原始文本整理成可以直接交给 WebVTT 渲染的纯文本。
 *
 * 时间轴之外的字幕「格式」千奇百怪：ASS 用 `{\pos(...)}` 控制定位、用 `\N` 换行，
 * SRT 里常见 `<font color=...>`，WebVTT 又只认少数几个标签 ——
 * 不清理的话，用户会看到 `{\an8}` 这类指令原样糊在屏幕上。
 */
export function normalizeCueText(raw: string): string {
  return String(raw ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/\{[^}]*\}/g, '')
    .replace(/\\[Nn]/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[ \t]+\n/g, '\n')
    .trim()
}

/** 判断字幕格式：先看内容特征，再退回扩展名 */
export function detectSubtitleFormat(content: string, filename = ''): SubtitleFormat {
  const text = String(content ?? '')
  if (/^\uFEFF?\s*WEBVTT/i.test(text)) return 'vtt'
  if (/^\s*\[(script info|v4\+? styles|events)\]/im.test(text)) return 'ass'
  if (/^\s*dialogue\s*:/im.test(text)) return 'ass'

  const arrow = text.match(/-->\s*([0-9:.,]+)/)
  if (arrow) return arrow[1].includes(',') ? 'srt' : 'vtt'

  const ext = String(filename ?? '')
    .toLowerCase()
    .split('.')
    .pop() as string
  if (ext === 'srt') return 'srt'
  if (ext === 'ass' || ext === 'ssa') return 'ass'
  if (ext === 'vtt') return 'vtt'
  return 'unknown'
}

/** `00:00:01,000 --> 00:00:04,000` 这类行；SRT 与 WebVTT 共用，差别只在毫秒分隔符 */
function parseArrowBlocks(content: string): SubtitleCue[] {
  const cues: SubtitleCue[] = []
  const blocks = String(content ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)

  for (const block of blocks) {
    const lines = block.split('\n')
    const timeIndex = lines.findIndex((line) => line.includes('-->'))
    if (timeIndex < 0) continue

    const [rawStart, rawEnd] = lines[timeIndex].split('-->')
    // WebVTT 允许在结束时间后面跟定位参数（`align:middle line:90%`），要切掉
    const endToken = (rawEnd ?? '').trim().split(/\s+/)[0]
    const start = parseTimestamp(rawStart)
    const end = parseTimestamp(endToken)
    const text = normalizeCueText(lines.slice(timeIndex + 1).join('\n'))

    if (!Number.isFinite(start) || !Number.isFinite(end) || !text) continue
    cues.push({ start, end: end > start ? end : start, text })
  }

  return cues
}

/** ASS / SSA：只认 `[Events]` 里的 `Dialogue:` 行，字段顺序以 `Format:` 为准 */
function parseAssBlocks(content: string): SubtitleCue[] {
  const cues: SubtitleCue[] = []
  const lines = String(content ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')

  let inEvents = false
  let fields = ASS_FIELDS

  for (const line of lines) {
    const trimmed = line.trim()

    if (trimmed.startsWith('[')) {
      inEvents = /^\[events\]$/i.test(trimmed)
      if (!inEvents) continue
      fields = ASS_FIELDS
      continue
    }
    if (!inEvents) continue

    if (/^format\s*:/i.test(trimmed)) {
      const declared = trimmed
        .slice(trimmed.indexOf(':') + 1)
        .split(',')
        .map((name) => name.trim().toLowerCase())
        .filter(Boolean)
      if (declared.length) fields = declared
      continue
    }

    if (!/^dialogue\s*:/i.test(trimmed)) continue

    const payload = trimmed.slice(trimmed.indexOf(':') + 1)
    const parts = payload.split(',')
    const textIndex = fields.indexOf('text')
    const cut = textIndex >= 0 ? textIndex : fields.length - 1
    // Text 是最后一个字段，本身还可能含逗号 —— 只能按字段个数切，剩下的全算文本
    const cells = parts.slice(0, cut)
    const rawText = parts.slice(cut).join(',')

    const start = parseTimestamp(cells[fields.indexOf('start')] ?? '')
    const end = parseTimestamp(cells[fields.indexOf('end')] ?? '')
    const text = normalizeCueText(rawText)

    if (!Number.isFinite(start) || !Number.isFinite(end) || !text) continue
    cues.push({ start, end: end > start ? end : start, text })
  }

  return cues
}

/**
 * 解析字幕内容 → 按时间排好序的字幕列表。
 *
 * 无法识别格式或一条有效字幕都没有时返回空数组，调用方据此给出「没读出一条字幕」的提示。
 */
export function parseSubtitle(content: string, filename = ''): SubtitleCue[] {
  const format = detectSubtitleFormat(content, filename)
  if (format === 'unknown') return []

  const cues = format === 'ass' ? parseAssBlocks(content) : parseArrowBlocks(content)
  return cues.sort((a, b) => a.start - b.start)
}

/** 把字幕列表回写成 WebVTT 文本（调试、导出、以及未来的 `<track>` 方案都用得上） */
export function cuesToVtt(cues: SubtitleCue[]): string {
  const body = cues
    .map((cue, index) => `${index + 1}\n${formatCueTime(cue.start)} --> ${formatCueTime(cue.end)}\n${cue.text}`)
    .join('\n\n')
  return `WEBVTT\n\n${body}\n`
}

/** 从路径里取不带扩展名的文件名，用来找「同名」字幕 */
export function basenameWithoutExt(filePath: string): string {
  const name = String(filePath ?? '').replace(/\\/g, '/').split('/').pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

/** 取小写扩展名（不含点） */
export function extensionOf(filePath: string): string {
  const name = String(filePath ?? '').replace(/\\/g, '/').split('/').pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/**
 * 从一堆候选文件里挑出「与视频同名的字幕」。
 *
 * 优先级：完全同名 > 以视频名开头（`剧名.01.chs.srt` 这种）> 同目录任意字幕。
 * 完全同名之外的结果都排在后面，避免把别的片子的字幕自动挂上来。
 */
export function pickSidecarSubtitles(
  videoPath: string,
  candidates: { path: string }[]
): { path: string; exact: boolean }[] {
  const base = basenameWithoutExt(videoPath).toLowerCase()
  const scored: { path: string; exact: boolean; rank: number }[] = []

  for (const item of candidates) {
    const name = basenameWithoutExt(item.path).toLowerCase()
    if (!name) continue
    if (name === base) scored.push({ path: item.path, exact: true, rank: 0 })
    else if (name.startsWith(base)) scored.push({ path: item.path, exact: true, rank: 1 })
    else scored.push({ path: item.path, exact: false, rank: 2 })
  }

  return scored
    .sort((a, b) => a.rank - b.rank || a.path.localeCompare(b.path))
    .map(({ path, exact }) => ({ path, exact }))
}
