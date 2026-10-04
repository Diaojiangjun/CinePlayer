<script setup lang="ts">
import Hls from 'hls.js'
import { ErrorDetails } from 'hls.js'
import type { ErrorData, FragLoadedData, LevelLoadedData } from 'hls.js'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { formatDuration } from '@renderer/utils/format'
import { createRateMeter, formatSpeed } from '@renderer/utils/rate'
import { isLegacyStreamProtocol, isStreamUrl, shouldUseHls, toMediaUrl } from '@renderer/utils/source'
import { parseSubtitle } from '../../../shared/subtitle'
import type { SubtitleFileInfo } from '../../../shared/subtitle'
import { mightBeSharePage } from '../../../shared/stream-resolve'
import type { MediaProbe } from '../../../shared/media'
import { emptyProfile, formatSkipPoint, skipAction, withSkipPoint } from '../../../shared/skip'
import type { SkipAction, SkipProfile } from '../../../shared/skip'
import { localSeriesKey } from '../../../shared/series'
import { useSkipStore } from '@renderer/stores/skip'

/** 选集面板里的一项 */
export interface PlayerEpisode {
  src: string
  name: string
  title: string
}

/** 字幕菜单里的一项 */
interface SubtitleOption {
  key: string
  label: string
  source: 'native' | 'hls' | 'file'
  index: number
}

/** 可切换的清晰度档位 */
interface QualityOption {
  index: number
  label: string
}

type MenuName = '' | 'rate' | 'subtitle' | 'quality' | 'skip'
type PanelName = '' | 'episodes'

const props = withDefaults(
  defineProps<{
    src: string
    poster?: string
    autoplay?: boolean
    startPosition?: number
    initialRate?: number
    initialVolume?: number
    /** 当前播放列表（剧集的每一集 / 媒体库的每一项），用于「选集」面板 */
    episodes?: PlayerEpisode[]
    /** 当前项在 `episodes` 中的下标；-1 表示不在列表里 */
    episodeIndex?: number
    /** 「选集」面板的标题 */
    queueLabel?: string
    /**
     * 这份播放列表属于哪部剧（`vod:<sourceId>:<vodId>`，见 `shared/series.ts`）。
     *
     * 片头片尾配置按它归组 —— 同一部剧换一集不该让用户重设一遍。
     * 留空时退化成按播放地址各自一份（直接打开单个文件的情形）。
     */
    seriesKey?: string
  }>(),
  {
    poster: '',
    autoplay: true,
    startPosition: 0,
    initialRate: 1,
    initialVolume: 1,
    episodes: () => [],
    episodeIndex: -1,
    queueLabel: '',
    seriesKey: ''
  }
)

const emit = defineEmits<{
  (e: 'progress', payload: { position: number; duration: number }): void
  (e: 'ended'): void
  (e: 'ready', payload: { duration: number }): void
  (e: 'error', message: string): void
  /** 用户在「选集」面板里换了集 */
  (e: 'select', index: number): void
}>()

const rootEl = ref<HTMLDivElement | null>(null)
const videoEl = ref<HTMLVideoElement | null>(null)

const playing = ref(false)
const buffering = ref(false)
const muted = ref(false)
const volume = ref(props.initialVolume)
const rate = ref(props.initialRate)
const currentTime = ref(0)
const duration = ref(0)
const controlsVisible = ref(true)

const fatalMessage = ref('')
const canFallbackTranscode = ref(false)
/** 自动播放被策略拦下了（正常不该发生，见 play()）。为真时浮出「点击播放」入口 */
const autoplayBlocked = ref(false)

const preparing = ref(false)
const preparePercent = ref(0)
const prepareLabel = ref('')
const prepareStage = ref<'remux' | 'transcode'>('remux')

/** 正在解析播放地址（分享页需要先取出真正的 m3u8） */
const resolving = ref(false)

/** 已缓冲区间（秒），画在进度条底层的浅色段 */
const bufferedRanges = ref<{ start: number; end: number }[]>([])
/** 跳转已发出但还没 seeked —— 这期间界面要停在用户点的位置上 */
const seekPending = ref(false)
const seekTarget = ref(0)
/** 拖拽/悬停时的预览位置（秒）；null 表示没有在预览 */
const previewTime = ref<number | null>(null)
/** 是否正在按住进度条拖动 */
const scrubbing = ref(false)
/** 网络速率（字节/秒），由 hls.js 的分片统计喂进来 */
const netSpeed = ref(0)

/* --- 控制栏浮层：右侧「选集」面板 + 控件上方的小菜单 --- */
const menu = ref<MenuName>('')
const panel = ref<PanelName>('')
const panelBody = ref<HTMLElement | null>(null)

/* --- 字幕 --- */
const subtitleOptions = ref<SubtitleOption[]>([])
/** 当前选中的字幕 key；`off` 表示关闭 */
const activeSubtitle = ref('off')
const subtitleBusy = ref(false)
const subtitleNotice = ref('')
/** 跳过片头片尾的一次性提示；与字幕提示共用同一条提示带 */
const skipNotice = ref('')
const noticeText = computed(() => subtitleNotice.value || skipNotice.value)
/** 已加载的外挂字幕：key → TextTrack。用 Map 持有引用，切换时才找得回来 */
const fileTracks = new Map<string, TextTrack>()
/** 同目录扫描到的字幕文件 */
const sidecarSubtitles = ref<SubtitleFileInfo[]>([])
/** 已经为哪个播放地址扫过同目录字幕（同一地址只扫一次） */
let scannedSubtitlesFor = ''

/* --- 清晰度（仅 HLS 多码率时有值） --- */
const qualityOptions = ref<QualityOption[]>([])
/** 用户选择的档位；-1 = 自动 */
const activeQuality = ref(-1)
/** 自动模式下实际生效的档位，用来在按钮上显示当前清晰度 */
const currentLevel = ref(-1)

const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2]

let hls: Hls | null = null
let hideTimer: number | undefined
let stopProgress: (() => void) | null = null
let loadingTimer: number | undefined
let seekGuardTimer: number | undefined
let noticeTimer: number | undefined
let lastEmit = 0
let lastSeekAt = 0
/** 上一次点击已经由指针流程处理过（pointerup 之后浏览器还会补一个 click） */
let pointerHandledClick = false
/** 当前已挂到 <video> 上的 URL；空串表示播放器已被清空 */
let activeUrl = ''
/** 请求序号，避免快速切换时旧请求覆盖新状态 */
let requestSeq = 0
let probeOfCurrent: MediaProbe | null = null
const meter = createRateMeter()

/** 已经为哪个地址做过「解析分享页」的补偿尝试 —— 同一地址只补一次，避免死循环 */
let shareRetriedFor = ''
/** hls.js 网络错误的重试次数。无上限重试会让坏地址永远转圈，必须封顶 */
let networkRetries = 0

const MAX_NETWORK_RETRIES = 3

/**
 * 滑块显示用的时间。
 *
 * 关键：不能直接用 `currentTime`。跳转要等分片下载完才真的开始播，
 * 那段时间 `timeupdate` 不会推进，滑块就会停在原地 —— 用户点了半天「没反应」。
 * 所以拖拽中显示预览位置、跳转中显示目标位置，都是**先给反馈**。
 */
const displayTime = computed(() => {
  if (scrubbing.value && previewTime.value !== null) return previewTime.value
  if (seekPending.value) return seekTarget.value
  return currentTime.value
})

const displayPercent = computed(() =>
  duration.value > 0 ? Math.min(Math.max((displayTime.value / duration.value) * 100, 0), 100) : 0
)

/** 已缓冲区间换算成百分比，供进度条底层渲染 */
const bufferedSegments = computed(() => {
  const total = duration.value
  if (!total) return []
  return bufferedRanges.value
    .map((range) => ({
      left: Math.min(Math.max((range.start / total) * 100, 0), 100),
      width: Math.min(Math.max(((range.end - range.start) / total) * 100, 0), 100)
    }))
    .filter((seg) => seg.width > 0.1)
})

/** 当前位置之前还剩多少秒内容已经躺在缓冲区里 */
const bufferedAhead = computed(() => {
  const at = displayTime.value
  for (const range of bufferedRanges.value) {
    if (at >= range.start - 0.5 && at <= range.end) return Math.max(0, range.end - at)
  }
  return 0
})

const bufferingVisible = computed(
  () =>
    (resolving.value || buffering.value || seekPending.value) &&
    !preparing.value &&
    !fatalMessage.value
)

const loadingLabel = computed(() => {
  if (resolving.value) return '正在解析播放地址…'
  if (seekPending.value) return `正在跳转到 ${formatDuration(seekTarget.value)}…`
  return '正在缓冲…'
})

/** 解析阶段还没有缓冲区间与速度可读，那一行整体不显示 */
const loadingStatsVisible = computed(() => !resolving.value)

const speedText = computed(() => formatSpeed(netSpeed.value))

/**
 * 前方可播时长。
 *
 * 跳转目标还没到时它是 0.0s，分片一到就跳成十几秒 —— 这个数字本身就是「加载进度」：
 * 用户看得到它在往上走，而不是只有一个转圈。
 */
const bufferedText = computed(() => `已缓冲 ${bufferedAhead.value.toFixed(1)}s`)

/** 悬停预览：把预览位置换算成百分比，用来定位小气泡 */
const previewPercent = computed(() =>
  previewTime.value !== null && duration.value > 0
    ? Math.min(Math.max((previewTime.value / duration.value) * 100, 0), 100)
    : null
)

/** 有播放列表才显示「选集」入口 —— 直接打开单个文件时不该出现一个空面板 */
const hasQueue = computed(() => props.episodes.length > 0)
const hasPrev = computed(() => props.episodeIndex > 0)
const hasNext = computed(
  () => props.episodeIndex >= 0 && props.episodeIndex < props.episodes.length - 1
)

/* --- 跳过片头片尾 --- */
const skipStore = useSkipStore()
/** 配置的归属 key：优先用上层给的剧集 key，直接打开单个文件时按地址各存一份 */
const skipKey = computed(() => props.seriesKey || localSeriesKey(props.src))
const skipProfile = computed<SkipProfile | null>(() => skipStore.get(skipKey.value))
const skipConfigured = computed(() => skipStore.configured(skipProfile.value))
const skipIntroEnd = computed(() => skipProfile.value?.introEnd ?? 0)
const skipOutroStart = computed(() => skipProfile.value?.outroStart ?? 0)
const skipAutoIntro = computed(() => skipProfile.value?.autoIntro === true)
const skipAutoOutro = computed(() => skipProfile.value?.autoOutro === true)

/**
 * 此刻该不该跳过（电平判定）。
 *
 * 用 `displayTime` 而不是 `currentTime`：跳转落地前 `currentTime` 停在旧位置，
 * 拿它判定会让按钮在跳转期间闪一下再回来。
 */
const skipStage = computed<SkipAction>(() =>
  skipAction(skipProfile.value, { time: displayTime.value, canSkipOutro: hasNext.value })
)

/**
 * 独立浮出的「跳过片头 / 跳过片尾」按钮。
 *
 * 它与控制栏分开渲染 —— 控制栏 2.6 秒后会自动收起，
 * 而片头往往有几十秒，按钮跟着一起消失等于点不到。
 * 开了「自动跳过」的那一端不再出按钮（已经替用户跳了）。
 */
const skipButton = computed<'' | 'intro' | 'outro'>(() => {
  // 选集面板占着右侧整条，浮出的按钮会被压在下面 —— 直接不渲染，免得点错
  if (panel.value === 'episodes') return ''
  const stage = skipStage.value
  if (stage === 'intro') return skipAutoIntro.value ? '' : 'intro'
  if (stage === 'outro') return skipAutoOutro.value ? '' : 'outro'
  return ''
})

/**
 * 「自动跳过」每集只出手一次。
 *
 * 不做闩锁的话，用户想看一遍片头就得跟它搏斗 ——
 * 往回拖进片头区间会被立刻弹回正片，等于被锁在片头之后。
 */
let autoSkippedIntro = false
let autoSkippedOutro = false

/** 清晰度按钮上的文字：手动选择时显示所选档位，自动时显示实际生效的档位 */
const qualityLabel = computed(() => {
  if (activeQuality.value >= 0) {
    return qualityOptions.value.find((item) => item.index === activeQuality.value)?.label ?? '自动'
  }
  const level = hls?.levels?.[currentLevel.value]
  return level ? levelLabel(level.height, level.bitrate) : '自动'
})

/** 字幕按钮上的数量提示，让用户一眼看出当前有没有字幕在工作 */
const subtitleActive = computed(() => activeSubtitle.value !== 'off')

function levelLabel(height: number, bitrate: number): string {
  if (height) return `${height}P`
  return `${Math.max(1, Math.round(bitrate / 1000))}K`
}

function destroyHls(): void {
  if (hls) {
    hls.destroy()
    hls = null
  }
  meter.reset()
  netSpeed.value = 0
  qualityOptions.value = []
  activeQuality.value = -1
  currentLevel.value = -1
  refreshSubtitleOptions()
}

function fileNameOf(filePath: string): string {
  return filePath.replace(/\\/g, '/').split('/').pop() || filePath
}

/* ------------------------------------------------------------------ *
 * 字幕：内嵌轨 / HLS 字幕轨 / 外挂文件
 * ------------------------------------------------------------------ */

/**
 * 收集当前可用的字幕。
 *
 * 三个来源互不相通，必须分别取：
 * - 封装在文件里的内嵌轨 → `video.textTracks`（**元数据加载后**才出现）
 * - HLS 流的字幕轨 → `hls.subtitleTracks`（不体现在 textTracks 上）
 * - 我们自己加载的外挂字幕 → `fileTracks`
 */
function refreshSubtitleOptions(): void {
  const video = videoEl.value
  const next: SubtitleOption[] = []

  if (video) {
    const tracks = video.textTracks
    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i]
      if (track.kind !== 'subtitles' && track.kind !== 'captions') continue
      next.push({
        key: `native:${i}`,
        label: track.label || track.language || `内嵌字幕 ${i + 1}`,
        source: 'native',
        index: i
      })
    }
  }

  if (hls) {
    hls.subtitleTracks.forEach((track, index) => {
      next.push({
        key: `hls:${index}`,
        label: track.name || track.lang || `流字幕 ${index + 1}`,
        source: 'hls',
        index
      })
    })
  }

  fileTracks.forEach((track, key) => {
    next.push({ key, label: track.label || '外挂字幕', source: 'file', index: 0 })
  })

  subtitleOptions.value = next

  // 源换了以后旧的选择可能已经不存在，别让按钮显示成「有字幕」却没内容
  if (activeSubtitle.value !== 'off' && !next.some((item) => item.key === activeSubtitle.value)) {
    activeSubtitle.value = 'off'
  }
}

/** 切换字幕；`off` 表示全部关掉 */
function applySubtitle(key: string): void {
  const video = videoEl.value
  activeSubtitle.value = key

  if (video) {
    const tracks = video.textTracks
    for (let i = 0; i < tracks.length; i++) tracks[i].mode = 'disabled'
  }
  if (hls) {
    hls.subtitleDisplay = false
    hls.subtitleTrack = -1
  }

  if (key === 'off') return
  const option = subtitleOptions.value.find((item) => item.key === key)
  if (!option) return

  if (option.source === 'native' && video) {
    const track = video.textTracks[option.index]
    if (track) track.mode = 'showing'
    return
  }

  if (option.source === 'hls' && hls) {
    hls.subtitleTrack = option.index
    hls.subtitleDisplay = true
    return
  }

  const track = fileTracks.get(key)
  if (track) track.mode = 'showing'
}

/**
 * 读一个外挂字幕文件并挂到播放器上。
 *
 * 走 `addTextTrack` + `VTTCue` 而不是 `<track src=blob:>`：
 * 不产生任何网络/协议请求，因此不受 CSP 与 `file://` 跨域限制。
 */
async function attachSubtitleFile(filePath: string, options: { auto: boolean }): Promise<boolean> {
  const video = videoEl.value
  if (!video) return false

  const key = `file:${filePath}`
  const name = fileNameOf(filePath)

  if (!fileTracks.has(key)) {
    subtitleBusy.value = true
    try {
      const content = await window.api.fs.readText(filePath)
      const cues = parseSubtitle(content, filePath)
      if (!cues.length) {
        subtitleNotice.value = `没能从 ${name} 里读出字幕，可能是格式不支持`
        return false
      }

      const track = video.addTextTrack('subtitles', name, 'zh')
      track.mode = 'hidden'
      for (const cue of cues) {
        try {
          track.addCue(new VTTCue(cue.start, cue.end, cue.text))
        } catch {
          /* 单条坏数据不该拖垮整段字幕 */
        }
      }
      fileTracks.set(key, track)
    } catch (error) {
      subtitleNotice.value = error instanceof Error ? error.message : '字幕读取失败'
      return false
    } finally {
      subtitleBusy.value = false
    }
  }

  refreshSubtitleOptions()
  applySubtitle(key)
  if (options.auto) subtitleNotice.value = `已自动加载字幕：${name}`
  return true
}

/**
 * 扫一遍视频同目录，找同名外挂字幕。
 *
 * 同名的直接挂上 —— 这是外挂字幕最常见的用法（`影片.mkv` + `影片.srt`），
 * 用户不用每次手动去菜单里点。同目录的其他字幕只列出来，不自动挂。
 */
async function scanSidecarSubtitles(videoPath: string): Promise<void> {
  if (!videoPath || scannedSubtitlesFor === videoPath) return
  scannedSubtitlesFor = videoPath
  try {
    const list = await window.api.fs.subtitles(videoPath)
    sidecarSubtitles.value = list
    const exact = list.find((item) => item.exact)
    if (exact && activeSubtitle.value === 'off') await attachSubtitleFile(exact.path, { auto: true })
  } catch {
    /* 没有字幕是常态，不用打扰用户 */
  }
}

/** 手动选一个字幕文件 */
async function loadSubtitleFile(): Promise<void> {
  try {
    const picked = await window.api.dialog.openSubtitle()
    if (!picked) return
    const ok = await attachSubtitleFile(picked, { auto: false })
    if (ok) {
      subtitleNotice.value = `已加载字幕：${fileNameOf(picked)}`
      menu.value = ''
    }
  } catch (error) {
    subtitleNotice.value = error instanceof Error ? error.message : '字幕读取失败'
  }
}

/* ------------------------------------------------------------------ *
 * 清晰度
 * ------------------------------------------------------------------ */

function refreshQualityOptions(): void {
  if (!hls || hls.levels.length < 2) {
    qualityOptions.value = []
    return
  }
  qualityOptions.value = hls.levels.map((level, index) => ({
    index,
    label: levelLabel(level.height, level.bitrate)
  }))
}

function applyQuality(index: number): void {
  activeQuality.value = index
  if (hls) hls.currentLevel = index
}

/* ------------------------------------------------------------------ *
 * 选集
 * ------------------------------------------------------------------ */

function selectEpisode(index: number): void {
  if (index < 0 || index >= props.episodes.length) return
  if (index === props.episodeIndex) {
    panel.value = ''
    return
  }
  emit('select', index)
}

function goPrev(): void {
  if (hasPrev.value) selectEpisode(props.episodeIndex - 1)
}

function goNext(): void {
  if (hasNext.value) selectEpisode(props.episodeIndex + 1)
}

/* ------------------------------------------------------------------ *
 * 跳过片头片尾
 * ------------------------------------------------------------------ */

/** 把播放头的当前位置设成片头结束点 / 片尾开始点 */
function setSkipPoint(which: 'intro' | 'outro'): void {
  const at = displayTime.value
  if (!(at > 0)) {
    skipNotice.value = '先把播放头拖到片头结束的位置，再点「设为当前」'
    return
  }

  const base = skipProfile.value ?? emptyProfile(skipKey.value)
  const window = withSkipPoint(base, which, at, duration.value)
  if (which === 'intro' && window.introEnd <= 0) {
    skipNotice.value = '这个位置不能作为片头结束点'
    return
  }
  if (which === 'outro' && window.outroStart <= 0) {
    skipNotice.value = '这个位置不能作为片尾开始点'
    return
  }

  void skipStore.save(skipKey.value, window, {
    autoIntro: base.autoIntro,
    autoOutro: base.autoOutro
  })

  // 冲突时 `withSkipPoint` 会清掉另一端，说清楚用户才知道自己的设置去哪了
  if (which === 'intro') {
    skipNotice.value =
      window.outroStart > 0 || base.outroStart <= 0
        ? `片头结束点：${formatSkipPoint(window.introEnd)}`
        : `片头结束点：${formatSkipPoint(window.introEnd)}（原片尾点已被清除）`
  } else {
    skipNotice.value =
      window.introEnd > 0 || base.introEnd <= 0
        ? `片尾开始点：${formatSkipPoint(window.outroStart)}`
        : `片尾开始点：${formatSkipPoint(window.outroStart)}（原片头点已被清除）`
  }
}

function toggleSkipAuto(which: 'intro' | 'outro'): void {
  const profile = skipProfile.value
  if (!profile) return
  void skipStore.save(
    skipKey.value,
    { introEnd: profile.introEnd, outroStart: profile.outroStart },
    {
      autoIntro: which === 'intro' ? !profile.autoIntro : profile.autoIntro,
      autoOutro: which === 'outro' ? !profile.autoOutro : profile.autoOutro
    }
  )
}

function clearSkip(): void {
  autoSkippedIntro = false
  autoSkippedOutro = false
  void skipStore.remove(skipKey.value)
  skipNotice.value = '已清除跳过片头片尾设置'
}

function skipIntro(): void {
  const end = skipIntroEnd.value
  if (end <= 0) return
  seekTo(end)
  skipNotice.value = `已跳过片头（${formatSkipPoint(end)}）`
  showControls()
}

/** 片尾跳过去的目的地就是下一集；没有下一集时按钮不会出现 */
function skipOutro(): void {
  if (hasNext.value) goNext()
}

/**
 * 自动跳过。
 *
 * 依赖里**必须带上 `duration`**：元数据还没就绪时 `seekTo()` 会被时长检查挡下来，
 * 而 `skipStage` 之后不会再变 —— 只盯着它就等于这一次永久错过了。
 *
 * 每集只自动出手一次（`autoSkipped*` 闩锁在 `resetState()` 里复位）：
 * 否则用户想回看片头，一拖进去就被弹回正片，等于被锁在片头之后。
 */
watch([skipStage, duration], ([stage]) => {
  const profile = skipProfile.value
  if (!profile || !stage || duration.value <= 0) return

  if (stage === 'intro') {
    if (!profile.autoIntro || autoSkippedIntro) return
    autoSkippedIntro = true
    seekTo(profile.introEnd)
    skipNotice.value = `已自动跳过片头（${formatSkipPoint(profile.introEnd)}）`
    return
  }

  if (!profile.autoOutro || autoSkippedOutro || !hasNext.value) return
  autoSkippedOutro = true
  goNext()
})

/* ------------------------------------------------------------------ *
 * 浮层开关
 * ------------------------------------------------------------------ */

function toggleMenu(name: Exclude<MenuName, ''>): void {
  panel.value = ''
  menu.value = menu.value === name ? '' : name
  showControls()
}

function togglePanel(name: Exclude<PanelName, ''>): void {
  menu.value = ''
  panel.value = panel.value === name ? '' : name
  showControls()
}

function closeLayers(): void {
  menu.value = ''
  panel.value = ''
  showControls()
}

/** 右键面板打开时把当前集滚到可视区，否则 80 集往后用户还得自己找 */
watch(panel, async (value) => {
  if (value !== 'episodes') return
  await nextTick()
  panelBody.value?.querySelector('.player__ep--active')?.scrollIntoView({ block: 'center' })
})

function resetState(): void {
  currentTime.value = 0
  duration.value = 0
  buffering.value = false
  playing.value = false
  fatalMessage.value = ''
  canFallbackTranscode.value = false
  autoplayBlocked.value = false
  preparing.value = false
  preparePercent.value = 0
  prepareLabel.value = ''
  bufferedRanges.value = []
  seekPending.value = false
  seekTarget.value = 0
  previewTime.value = null
  netSpeed.value = 0
  scrubbing.value = false
  pointerHandledClick = false
  resolving.value = false
  shareRetriedFor = ''
  networkRetries = 0
  meter.reset()
  probeOfCurrent = null
  // 刻意**不**关掉「选集」面板：连着换几集时用户不想每换一次就重新点开一次。
  // 菜单同理，源换了以后 v-if / 下一轮事件会自己把它刷新掉。
  activeSubtitle.value = 'off'
  subtitleOptions.value = []
  subtitleNotice.value = ''
  sidecarSubtitles.value = []
  scannedSubtitlesFor = ''
  fileTracks.clear()
  qualityOptions.value = []
  activeQuality.value = -1
  currentLevel.value = -1
  // 换集 = 新的一集，自动跳过要重新有机会出手
  skipNotice.value = ''
  autoSkippedIntro = false
  autoSkippedOutro = false
}

/**
 * 把 `video.buffered` 抄进响应式状态。
 *
 * 注意 `TimeRanges` 是**活对象**：不能直接塞进 ref（它不会被观察到，也无法序列化），
 * 必须逐段读成普通数组。跳转后浏览器会丢掉旧区间，所以这里会自然变成多段/单段。
 */
function syncBuffered(): void {
  const video = videoEl.value
  if (!video) return
  const ranges = video.buffered
  const next: { start: number; end: number }[] = []
  for (let i = 0; i < ranges.length; i++) {
    const start = ranges.start(i)
    const end = ranges.end(i)
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) next.push({ start, end })
  }
  bufferedRanges.value = next
}

function clearVideo(): void {
  const video = videoEl.value
  if (!video) return
  activeUrl = ''
  destroyHls()
  video.removeAttribute('src')
  video.load()
}

function applyUrl(url: string): void {
  const video = videoEl.value
  if (!video) return
  activeUrl = url
  video.src = url
  video.playbackRate = rate.value
  video.volume = volume.value
  video.muted = muted.value
  video.load()
}

function fail(message: string, allowTranscodeFallback = false): void {
  preparing.value = false
  buffering.value = false
  fatalMessage.value = message
  canFallbackTranscode.value = allowTranscodeFallback
  emit('error', message)
}

/* ------------------------------------------------------------------ *
 * 装载流程
 * ------------------------------------------------------------------ */

/**
 * 把播放地址交给主进程解析一次。
 *
 * 有一类地址是**网页**而不是媒体文件（形如 `https://host/share/<id>`）：
 * 浏览器里能直接播，是因为页面内联脚本里写着真正的 m3u8 地址。
 * 直接把网页丢给 hls.js 只会得到 manifest 解析错误 —— 表现就是「点了没反应」。
 *
 * 返回 `null` 表示已经报了可读错误，调用方不要再往下走。
 */
async function resolveStreamUrl(raw: string): Promise<string | null> {
  const api = window.api?.stream
  if (!api) return raw

  resolving.value = true
  try {
    const result = await api.resolve(raw)
    if (!result.ok) {
      fail(result.error || '无法解析该播放地址')
      return null
    }
    return result.url
  } catch (error) {
    // 解析只是「更好」，不该成为播放的必要条件：出问题就退回原地址按老路走
    console.warn('[player] 播放地址解析失败，按原地址继续', error)
    return raw
  } finally {
    resolving.value = false
  }
}

/** hls.js 说「这不是播放列表」时，大概率是拿到了分享页 HTML —— 解析后再试一次 */
async function retryWithResolvedSharePage(raw: string): Promise<void> {
  destroyHls()
  const resolved = await resolveStreamUrl(raw)
  if (resolved === null) return
  if (resolved === raw) {
    fail('流媒体加载失败：该地址返回的不是播放列表，也没能在页面里找到播放地址')
    return
  }
  loadStream(resolved)
}

function loadStream(url: string): void {
  const video = videoEl.value
  if (!video) return

  if (isLegacyStreamProtocol(url)) {
    fail('该地址使用 RTMP/RTSP 协议，Chromium 内核无法直接播放，请改用 http(s) 的 m3u8 或 mp4 地址')
    return
  }

  if (shouldUseHls(url) && Hls.isSupported()) {
    hls = new Hls({ enableWorker: true, lowLatencyMode: false, backBufferLength: 90 })
    let fellBack = false

    hls.loadSource(url)
    hls.attachMedia(video)

    // 网络速度：hls.js 每个分片/播放列表都带真实的字节数与耗时，是唯一可信的来源
    // （原生 <video> 没有暴露任何字节级别的下载信息）。
    hls.on(Hls.Events.FRAG_LOADED, (_event, data: FragLoadedData) => {
      const stats = data.frag?.stats
      if (!stats) return
      meter.push(stats.loaded || stats.total || 0, stats.loading.end - stats.loading.start)
      netSpeed.value = meter.read()
    })
    hls.on(Hls.Events.LEVEL_LOADED, (_event, data: LevelLoadedData) => {
      const stats = data.stats
      if (!stats) return
      meter.push(stats.loaded || stats.total || 0, stats.loading.end - stats.loading.start)
      netSpeed.value = meter.read()
    })

    // 多码率流才有「清晰度」可切；字幕轨可能比清单晚一步到达，所以两个事件都要跟
    hls.on(Hls.Events.MANIFEST_PARSED, () => refreshQualityOptions())
    hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
      currentLevel.value = data.level
    })
    hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, () => refreshSubtitleOptions())

    hls.on(Hls.Events.ERROR, (_event, data: ErrorData) => {
      if (!data.fatal) return

      // 「拿到的不是播放列表」通常意味着这个地址其实是网页（分享页）。
      // 必须先走这条分支：它属于 NETWORK_ERROR，会被下面的重试逻辑无限重试下去。
      if (data.details === ErrorDetails.MANIFEST_PARSING_ERROR && shareRetriedFor !== url) {
        shareRetriedFor = url
        void retryWithResolvedSharePage(url)
        return
      }

      if (data.type === Hls.ErrorTypes.NETWORK_ERROR && networkRetries < MAX_NETWORK_RETRIES) {
        networkRetries++
        hls?.startLoad()
        return
      }

      if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        hls?.recoverMediaError()
        return
      }

      // 直播源里混着直链 mp4 的情况很常见，HLS 走不通时回退给原生播放器
      if (!fellBack) {
        fellBack = true
        destroyHls()
        applyUrl(url)
        return
      }
      fail('流媒体加载失败，请检查源地址或网络')
    })

    video.playbackRate = rate.value
    video.volume = volume.value
    video.muted = muted.value
    activeUrl = url
    return
  }

  applyUrl(url)
}

async function loadLocal(filePath: string, forceTranscode = false): Promise<void> {
  const seq = ++requestSeq
  const api = window.api.media

  preparing.value = true
  preparePercent.value = 0
  prepareLabel.value = '正在分析视频…'
  prepareStage.value = 'remux'

  try {
    const probe = await api.probe(filePath)
    if (seq !== requestSeq) return
    probeOfCurrent = probe

    if (!probe.ok) {
      fail(probe.message || '无法解析该视频文件', false)
      return
    }

    if (!forceTranscode && probe.strategy === 'direct') {
      applyUrl(toMediaUrl(filePath))
      preparing.value = false
      return
    }

    if (!forceTranscode && probe.strategy === 'unsupported') {
      fail(probe.message || '该视频编码不受支持')
      return
    }

    prepareStage.value = forceTranscode || probe.strategy === 'transcode' ? 'transcode' : 'remux'
    prepareLabel.value =
      prepareStage.value === 'transcode'
        ? `正在转码为 H.264（源编码 ${probe.videoCodec.toUpperCase()}），大文件耗时较长…`
        : `正在转换封装格式（${probe.container.toUpperCase()} / ${probe.videoCodec.toUpperCase()}）…`

    const result = await api.prepare(filePath, { forceTranscode })
    if (seq !== requestSeq) return

    if (!result.ok) {
      fail(result.message || '视频准备失败', true)
      return
    }

    applyUrl(toMediaUrl(result.path))
    preparing.value = false
  } catch (error) {
    if (seq !== requestSeq) return
    fail(error instanceof Error ? error.message : '播放失败')
  }
}

async function loadSource(): Promise<void> {
  const video = videoEl.value
  if (!video) return

  const seq = ++requestSeq

  resetState()
  clearVideo()
  if (!props.src) return

  if (isStreamUrl(props.src)) {
    // 分享页地址（真正的 m3u8 藏在网页脚本里）要先解析出可播地址；
    // 带 .m3u8 / .mp4 这类明确扩展名的地址直接播，省掉一次网络往返。
    const target = mightBeSharePage(props.src) ? await resolveStreamUrl(props.src) : props.src
    if (seq !== requestSeq) return
    if (target === null) return
    loadStream(target)
    return
  }

  await loadLocal(props.src)
}

async function retryWithTranscode(): Promise<void> {
  if (!props.src) return
  resetState()
  clearVideo()
  await loadLocal(props.src, true)
}

/* ------------------------------------------------------------------ *
 * 播放控制
 * ------------------------------------------------------------------ */

function play(): void {
  const video = videoEl.value
  if (!video) return

  // ⚠️ 这里曾经是 `.catch(() => {})` —— 自动播放被拦下后完全无声，
  // 用户看到的是「视频不动」，我们这边连一行日志都没有，排查只能靠猜。
  // 现在把失败原因记下来，并浮出一个「点击播放」的补救入口。
  const attempt = video.play()
  if (!attempt || typeof attempt.then !== 'function') return
  attempt.then(
    () => {
      autoplayBlocked.value = false
    },
    (error: unknown) => {
      autoplayBlocked.value = true
      console.warn(
        '[player] 自动播放被拦截（通常是自动播放策略），已提供点击播放入口：',
        (error as { name?: string } | null)?.name ?? error
      )
    }
  )
}

/** 用户点了补救入口：这是一次真实手势，再播一次一定成功 */
function playByGesture(): void {
  autoplayBlocked.value = false
  play()
}

function togglePlay(): void {
  const video = videoEl.value
  if (!video) return
  if (video.paused) video.play().catch(() => undefined)
  else video.pause()
}

function seekTo(seconds: number): void {
  const video = videoEl.value
  const total = duration.value
  if (!video || !total) return

  const target = Math.max(0, Math.min(seconds, total))
  lastSeekAt = Date.now()
  previewTime.value = null
  // 乐观更新：先把滑块和时间挪过去，点下去立刻有反馈，不等分片下载完
  currentTime.value = target
  showControls()

  // 位置几乎没变时浏览器不会发 seeking/seeked，别把自己挂住
  if (Math.abs(video.currentTime - target) < 0.05) {
    seekTarget.value = target
    seekPending.value = false
    return
  }

  seekTarget.value = target
  seekPending.value = true
  video.currentTime = target
  syncBuffered()
  armSeekGuard()
}

/** 极端情况下（例如 hls 卡住）`seeked` 可能一直不来，别让遮罩永远盖着 */
function armSeekGuard(): void {
  window.clearTimeout(seekGuardTimer)
  seekGuardTimer = window.setTimeout(() => {
    if (!seekPending.value) return
    seekPending.value = false
    const video = videoEl.value
    if (video) currentTime.value = video.currentTime
  }, 8000)
}

function skip(delta: number): void {
  seekTo(currentTime.value + delta)
}

/** 把指针横坐标换算成秒（自动夹在 [0, duration] 内） */
function timeFromPointer(event: PointerEvent | MouseEvent): number {
  const track = event.currentTarget as HTMLElement
  const rect = track.getBoundingClientRect()
  const ratio = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0
  return Math.max(0, Math.min(1, ratio)) * duration.value
}

function onProgressPointerDown(event: PointerEvent): void {
  if (!duration.value) return
  scrubbing.value = true
  const track = event.currentTarget as HTMLElement
  try {
    track.setPointerCapture(event.pointerId)
  } catch {
    /* 不支持指针捕获时退化成普通拖拽 */
  }
  previewTime.value = timeFromPointer(event)
  showControls()
}

function onProgressPointerMove(event: PointerEvent): void {
  if (!duration.value) return
  previewTime.value = timeFromPointer(event)
  if (scrubbing.value) showControls()
}

function onProgressPointerUp(event: PointerEvent): void {
  if (!scrubbing.value) return
  scrubbing.value = false
  const track = event.currentTarget as HTMLElement
  try {
    track.releasePointerCapture(event.pointerId)
  } catch {
    /* ignore */
  }
  const target = timeFromPointer(event)
  previewTime.value = null
  // pointerup 之后浏览器还会补一个 click，标记一下别让它再跳一次
  pointerHandledClick = true
  seekTo(target)
}

function onProgressPointerLeave(): void {
  if (scrubbing.value) return
  previewTime.value = null
}

function onSeekClick(event: MouseEvent): void {
  // 只吞掉紧接着 pointerup 的那一次 click（合成点击 / 辅助技术不会走指针流程）。
  // 带 500ms 时限，避免指针流程没生成 click 时把用户的下一次点击也吃掉。
  const handledByPointer = pointerHandledClick && Date.now() - lastSeekAt < 500
  pointerHandledClick = false
  if (handledByPointer) return
  previewTime.value = null
  seekTo(timeFromPointer(event))
}

function onVolumeChange(): void {
  const video = videoEl.value
  if (!video) return
  video.volume = volume.value
  video.muted = volume.value === 0
  muted.value = video.muted
}

function toggleMute(): void {
  const video = videoEl.value
  if (!video) return
  video.muted = !video.muted
  muted.value = video.muted
}

function onRateChange(): void {
  if (videoEl.value) videoEl.value.playbackRate = rate.value
}

function toggleFullscreen(): void {
  const el = rootEl.value
  if (!el) return
  if (document.fullscreenElement) document.exitFullscreen().catch(() => undefined)
  else el.requestFullscreen().catch(() => undefined)
}

async function togglePip(): Promise<void> {
  const video = videoEl.value
  if (!video) return
  try {
    if (document.pictureInPictureElement) await document.exitPictureInPicture()
    else await video.requestPictureInPicture()
  } catch {
    /* 浏览器/环境不支持画中画时忽略 */
  }
}

function showControls(): void {
  controlsVisible.value = true
  window.clearTimeout(hideTimer)
  hideTimer = window.setTimeout(() => {
    // 菜单/面板还开着的时候不能收控制栏，否则用户刚点开就没了
    if (playing.value && !menu.value && !panel.value) controlsVisible.value = false
  }, 2600)
}

/** 点画面：浮层开着就先收起浮层，否则切换播放/暂停 */
function onVideoClick(): void {
  if (menu.value || panel.value) {
    closeLayers()
    return
  }
  togglePlay()
}

/**
 * 加载期间的心跳。
 *
 * 速度读数需要定期重算（数据停流时要衰减到 0），缓冲区间也要跟着长 ——
 * 光靠 `progress` 事件在「卡住」时是不会有新事件的，而卡住恰恰是最需要看反馈的时候。
 */
function startLoadingTicker(): void {
  if (loadingTimer !== undefined) return
  loadingTimer = window.setInterval(() => {
    netSpeed.value = meter.read()
    syncBuffered()
  }, 400)
}

function stopLoadingTicker(): void {
  if (loadingTimer === undefined) return
  window.clearInterval(loadingTimer)
  loadingTimer = undefined
}

watch(bufferingVisible, (visible) => {
  if (visible) startLoadingTicker()
  else stopLoadingTicker()
})

async function cancelPrepare(): Promise<void> {
  if (!props.src) return
  prepareLabel.value = '正在取消…'
  await window.api.media.cancel(props.src)
}

/* ------------------------------------------------------------------ *
 * 媒体事件
 * ------------------------------------------------------------------ */

function onTimeUpdate(): void {
  const video = videoEl.value
  if (!video) return
  duration.value = video.duration || duration.value
  // 跳转还没落地时不要用旧的播放头覆盖乐观位置，否则滑块会「弹回去」
  if (!seekPending.value) currentTime.value = video.currentTime
  syncBuffered()

  const now = Date.now()
  if (now - lastEmit > 2000) {
    lastEmit = now
    emit('progress', { position: currentTime.value, duration: duration.value })
  }
}

function onLoadedMetadata(): void {
  const video = videoEl.value
  if (!video) return
  duration.value = video.duration || probeOfCurrent?.duration || 0

  // 续播定位排在起播之前（反过来的话会先从头播一瞬再跳回去）。
  // 单独包一层：媒体还没 seekable 时这一步可能抛异常，绝不能连带把自动播放弄没。
  try {
    if (props.startPosition > 0 && props.startPosition < duration.value - 3) {
      video.currentTime = props.startPosition
    }
  } catch (error) {
    console.warn('[player] 续播定位失败，从头播放', error)
  }
  syncBuffered()

  /*
   * ⚠️ 起播必须**尽早**调用，而且要在所有「增强功能」之前。
   *
   * 这里曾经把 `play()` 放在函数最后一行：只要上面任何一步抛异常（刷新字幕轨、
   * 续播定位、emit 回调……），自动播放就会被整个跳过 —— 视频停在第一帧，
   * 用户只能手动点一下。而 `play()` 的失败当时又是 `.catch(() => {})` 静默吞掉的，
   * 于是「每次都要手动点击」既没有日志也没有提示，只能靠猜。
   * 现在：起播前置，后面的增强功能各自兜底，任何一项失败都不影响播放。
   */
  if (props.autoplay) play()

  // 内嵌字幕轨要等元数据就绪才出现在 textTracks 上，这里必须刷新一次（失败不影响播放）
  try {
    refreshSubtitleOptions()
  } catch (error) {
    console.warn('[player] 刷新字幕轨道失败', error)
  }
  if (!isStreamUrl(props.src)) void scanSidecarSubtitles(props.src)
  try {
    emit('ready', { duration: duration.value })
  } catch (error) {
    console.warn('[player] ready 回调异常', error)
  }
}

/** 浏览器开始跳转（也可能来自内部重定位，不只用户点击） */
function onSeeking(): void {
  const video = videoEl.value
  if (!video) return
  if (!seekPending.value) {
    seekTarget.value = video.currentTime
    seekPending.value = true
  }
  armSeekGuard()
  showControls()
}

function onSeeked(): void {
  const video = videoEl.value
  seekPending.value = false
  window.clearTimeout(seekGuardTimer)
  if (video) {
    currentTime.value = video.currentTime
    duration.value = video.duration || duration.value
  }
  syncBuffered()
  // 立刻记一次进度：拖过去就退出时不该丢失新位置
  emit('progress', { position: currentTime.value, duration: duration.value })
}

function onPlay(): void {
  playing.value = true
  // 真的播起来了：把「自动播放被拦截」的补救入口收掉
  autoplayBlocked.value = false
}

function onPause(): void {
  playing.value = false
  controlsVisible.value = true
  emit('progress', { position: currentTime.value, duration: duration.value })
}

function onEnded(): void {
  playing.value = false
  emit('progress', { position: duration.value, duration: duration.value })
  emit('ended')
  // 追剧场景下播完自动续下一集，省得每次手动点
  if (hasNext.value) goNext()
}

async function onVideoError(): Promise<void> {
  // clearVideo() 主动清空 src 时也会触发 error，这里忽略
  if (!activeUrl) return
  if (isStreamUrl(props.src)) {
    fail('流媒体加载失败，请检查源地址或网络')
    return
  }

  const codec = probeOfCurrent?.videoCodec ? probeOfCurrent.videoCodec.toUpperCase() : '未知编码'
  let ffmpegReady = false
  try {
    const caps = await window.api.media.capabilities()
    ffmpegReady = caps.ffmpeg
  } catch {
    ffmpegReady = false
  }

  fail(
    ffmpegReady
      ? `播放失败：Chromium 内核无法解码该视频（${codec}）。可以转码为 H.264 后再播放，大文件耗时较长。`
      : `播放失败：Chromium 内核无法解码该视频（${codec}），且未检测到 FFmpeg，无法自动转换。`,
    ffmpegReady
  )
}

function onKeydown(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null
  if (target && /INPUT|TEXTAREA|SELECT/.test(target.tagName)) return

  switch (event.key) {
    case ' ':
    case 'Space':
      event.preventDefault()
      togglePlay()
      break
    case 'ArrowRight':
      event.preventDefault()
      skip(5)
      break
    case 'ArrowLeft':
      event.preventDefault()
      skip(-5)
      break
    case 'ArrowUp':
      event.preventDefault()
      volume.value = Math.min(1, volume.value + 0.05)
      onVolumeChange()
      break
    case 'ArrowDown':
      event.preventDefault()
      volume.value = Math.max(0, volume.value - 0.05)
      onVolumeChange()
      break
    case 'm':
    case 'M':
      toggleMute()
      break
    case 'f':
    case 'F':
      toggleFullscreen()
      break
    case 'Escape':
      closeLayers()
      break
    default:
      break
  }
}

/** 提示信息是「说过就忘」的，别一直挂在画面上 */
watch(noticeText, (text) => {
  window.clearTimeout(noticeTimer)
  if (!text) return
  noticeTimer = window.setTimeout(() => {
    subtitleNotice.value = ''
    skipNotice.value = ''
  }, 3200)
})

watch(
  () => props.src,
  () => {
    void loadSource()
  }
)

onMounted(() => {
  stopProgress = window.api.media.onProgress((progress) => {
    if (progress.path !== props.src) return
    preparePercent.value = progress.percent
    prepareLabel.value = progress.message
    if (progress.state === 'done') preparePercent.value = 100
  })

  // 跳过片头片尾的配置是异步读出来的；读完后 `skipStage` 变化会自动触发
  // 自动跳过（见上面那个 watch），不需要在这里做额外调度。
  if (!skipStore.ready) void skipStore.load()

  void loadSource()
  window.addEventListener('keydown', onKeydown)
  showControls()
})

onBeforeUnmount(() => {
  requestSeq++
  stopProgress?.()
  stopLoadingTicker()
  window.clearTimeout(seekGuardTimer)
  window.clearTimeout(noticeTimer)
  window.removeEventListener('keydown', onKeydown)
  window.clearTimeout(hideTimer)
  if (props.src) void window.api.media.cancel(props.src)
  destroyHls()
})

defineExpose({
  togglePlay,
  seekTo,
  play
})
</script>

<template>
  <div ref="rootEl" class="player" @mousemove="showControls" @mouseleave="showControls">
    <video
      ref="videoEl"
      class="player__video"
      :poster="poster || undefined"
      playsinline
      @click="onVideoClick"
      @dblclick="toggleFullscreen"
      @timeupdate="onTimeUpdate"
      @durationchange="syncBuffered"
      @loadedmetadata="onLoadedMetadata"
      @progress="syncBuffered"
      @play="onPlay"
      @pause="onPause"
      @ended="onEnded"
      @seeking="onSeeking"
      @seeked="onSeeked"
      @waiting="buffering = true"
      @playing="buffering = false"
      @canplay="buffering = false"
      @emptied="bufferedRanges = []"
      @error="onVideoError"
    ></video>

    <transition name="fade">
      <div v-if="bufferingVisible" class="player__loading" aria-live="polite">
        <div class="player__spinner"></div>
        <p class="player__loading-label">{{ loadingLabel }}</p>
        <p v-if="loadingStatsVisible" class="player__loading-stats">
          <span v-if="speedText" class="player__loading-speed">{{ speedText }}</span>
          <span v-if="speedText" class="player__loading-dot">·</span>
          <span class="player__loading-buffer">{{ bufferedText }}</span>
        </p>
      </div>
    </transition>

    <transition name="fade">
      <div v-if="preparing" class="player__prepare">
        <p class="player__prepare-label">{{ prepareLabel }}</p>
        <div class="player__prepare-track">
          <div
            class="player__prepare-bar"
            :class="{ 'player__prepare-bar--indet': prepareStage === 'transcode' && !preparePercent }"
            :style="{ width: preparePercent ? preparePercent + '%' : '30%' }"
          ></div>
        </div>
        <div class="player__prepare-foot">
          <span class="player__prepare-percent">{{ preparePercent }}%</span>
          <button class="player__prepare-cancel" @click="cancelPrepare">取消</button>
        </div>
      </div>
    </transition>

    <div v-if="fatalMessage && !preparing" class="player__error">
      <p>{{ fatalMessage }}</p>
      <button v-if="canFallbackTranscode" class="player__error-action" @click="retryWithTranscode">
        转码为 H.264 后播放
      </button>
    </div>

    <div v-if="!src" class="player__empty">暂无播放内容</div>

    <!--
      自动播放被策略拦下时的补救入口。
      正常情况下主进程已放开自动播放策略（见 src/main/index.ts），这块不会出现；
      万一仍被拦下，也要让用户「点一下画面」就能播，而不是到处找播放按钮。
    -->
    <button
      v-if="autoplayBlocked && !preparing && !fatalMessage"
      class="player__autoplay"
      type="button"
      title="播放"
      @click="playByGesture"
    >
      <span class="player__autoplay-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="28" height="28">
          <path d="M8 5.2v13.6L19 12z" fill="currentColor" />
        </svg>
      </span>
      <span class="player__autoplay-text">点击播放</span>
    </button>

    <!-- 选集：从右侧滑出的分集面板，仿腾讯视频电脑端 -->
    <transition name="slide-panel">
      <aside v-if="hasQueue && panel === 'episodes'" class="player__panel">
        <header class="player__panel-head">
          <div class="player__panel-meta">
            <p class="player__panel-title">{{ queueLabel || '选集' }}</p>
            <p class="player__panel-sub">共 {{ episodes.length }} 集</p>
          </div>
          <button class="player__panel-close" title="收起" @click="panel = ''">
            <svg viewBox="0 0 24 24" width="18" height="18">
              <path
                d="M6 6l12 12M18 6L6 18"
                fill="none"
                stroke="currentColor"
                stroke-width="1.9"
                stroke-linecap="round"
              />
            </svg>
          </button>
        </header>

        <div ref="panelBody" class="player__panel-body">
          <button
            v-for="(episode, index) in episodes"
            :key="episode.src + index"
            class="player__ep"
            :class="{ 'player__ep--active': index === episodeIndex }"
            :title="episode.title"
            @click="selectEpisode(index)"
          >
            {{ episode.name }}
          </button>
        </div>
      </aside>
    </transition>

    <!--
      跳过片头 / 片尾：**独立于控制栏**。
      控制栏 2.6 秒后会自动收起，而片头往往有几十秒 —— 按钮跟着一起消失就等于点不到。
    -->
    <button v-if="skipButton === 'intro'" class="player__skip" @click="skipIntro">
      跳过片头
      <span class="player__skip-time">{{ formatSkipPoint(skipIntroEnd) }}</span>
    </button>
    <button v-else-if="skipButton === 'outro'" class="player__skip" @click="skipOutro">
      跳过片尾
      <span class="player__skip-time">下一集</span>
    </button>

    <!-- 一次性提示（自动加载了同名字幕 / 跳过了片头 / 设置结果） -->
    <transition name="fade">
      <p v-if="noticeText" class="player__notice">{{ noticeText }}</p>
    </transition>

    <transition name="fade">
      <div v-show="controlsVisible" class="player__controls">
        <div
          class="player__progress"
          @pointerdown="onProgressPointerDown"
          @pointermove="onProgressPointerMove"
          @pointerup="onProgressPointerUp"
          @pointercancel="onProgressPointerUp"
          @pointerleave="onProgressPointerLeave"
          @click="onSeekClick"
        >
          <div class="player__progress-track">
            <div
              v-for="(seg, index) in bufferedSegments"
              :key="index"
              class="player__progress-buffered"
              :style="{ left: seg.left + '%', width: seg.width + '%' }"
            ></div>
            <div class="player__progress-played" :style="{ width: displayPercent + '%' }"></div>
            <div class="player__progress-thumb" :style="{ left: displayPercent + '%' }"></div>
          </div>
          <span
            v-if="previewPercent !== null"
            class="player__progress-tip"
            :style="{ left: previewPercent + '%' }"
          >
            {{ formatDuration(previewTime) }}
          </span>
        </div>

        <div class="player__bar">
          <button class="player__btn" :title="playing ? '暂停' : '播放'" @click="togglePlay">
            <svg v-if="playing" viewBox="0 0 24 24" width="20" height="20">
              <rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" />
              <rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" />
            </svg>
            <svg v-else viewBox="0 0 24 24" width="20" height="20">
              <path d="M8 5v14l11-7z" fill="currentColor" />
            </svg>
          </button>

          <template v-if="hasQueue">
            <button
              class="player__btn"
              title="上一集"
              :disabled="!hasPrev"
              @click="goPrev"
            >
              <svg viewBox="0 0 24 24" width="20" height="20">
                <path d="M18 6v12L9.5 12z" fill="currentColor" />
                <rect x="6" y="6" width="2.2" height="12" rx="1" fill="currentColor" />
              </svg>
            </button>

            <button
              class="player__btn"
              title="下一集"
              :disabled="!hasNext"
              @click="goNext"
            >
              <svg viewBox="0 0 24 24" width="20" height="20">
                <path d="M6 6v12l8.5-6z" fill="currentColor" />
                <rect x="15.8" y="6" width="2.2" height="12" rx="1" fill="currentColor" />
              </svg>
            </button>
          </template>

          <span class="player__time">
            {{ formatDuration(displayTime) }} / {{ formatDuration(duration) }}
          </span>

          <div class="player__spacer"></div>

          <div v-if="qualityOptions.length" class="player__tool">
            <button
              class="player__text-btn"
              :class="{ 'is-open': menu === 'quality' }"
              title="清晰度"
              @click="toggleMenu('quality')"
            >
              {{ qualityLabel }}
            </button>
            <div v-if="menu === 'quality'" class="player__menu">
              <button
                class="player__menu-item"
                :class="{ 'is-active': activeQuality === -1 }"
                @click="applyQuality(-1); menu = ''"
              >
                自动
              </button>
              <button
                v-for="option in qualityOptions"
                :key="option.index"
                class="player__menu-item"
                :class="{ 'is-active': activeQuality === option.index }"
                @click="applyQuality(option.index); menu = ''"
              >
                {{ option.label }}
              </button>
            </div>
          </div>

          <div class="player__tool">
            <button
              class="player__text-btn"
              :class="{ 'is-open': menu === 'rate' }"
              title="播放速度"
              @click="toggleMenu('rate')"
            >
              {{ rate }}x
            </button>
            <div v-if="menu === 'rate'" class="player__menu">
              <button
                v-for="value in RATES"
                :key="value"
                class="player__menu-item"
                :class="{ 'is-active': rate === value }"
                @click="rate = value; onRateChange(); menu = ''"
              >
                {{ value }}x
              </button>
            </div>
          </div>

          <div class="player__tool">
            <button
              class="player__btn"
              :class="{ 'is-active': subtitleActive }"
              title="字幕"
              @click="toggleMenu('subtitle')"
            >
              <svg viewBox="0 0 24 24" width="20" height="20">
                <rect
                  x="3"
                  y="5"
                  width="18"
                  height="14"
                  rx="2.4"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.7"
                />
                <path
                  d="M6.5 10.5h5M6.5 14h3.5M14.5 10.5h3M12.5 14h5"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.5"
                  stroke-linecap="round"
                />
              </svg>
              <span v-if="subtitleActive" class="player__badge-dot"></span>
            </button>

            <div v-if="menu === 'subtitle'" class="player__menu player__menu--wide">
              <p class="player__menu-title">字幕</p>
              <button
                class="player__menu-item"
                :class="{ 'is-active': !subtitleActive }"
                @click="applySubtitle('off'); menu = ''"
              >
                关闭
              </button>
              <button
                v-for="option in subtitleOptions"
                :key="option.key"
                class="player__menu-item"
                :class="{ 'is-active': activeSubtitle === option.key }"
                :title="option.label"
                @click="applySubtitle(option.key); menu = ''"
              >
                {{ option.label }}
              </button>
              <p v-if="!subtitleOptions.length && !sidecarSubtitles.length" class="player__menu-empty">
                没有可选字幕
              </p>
              <div class="player__menu-split"></div>
              <button
                v-for="file in sidecarSubtitles"
                :key="'side-' + file.path"
                class="player__menu-item player__menu-item--sub"
                :title="file.path"
                @click="attachSubtitleFile(file.path, { auto: false }); menu = ''"
              >
                同目录：{{ file.name }}
              </button>
              <button
                class="player__menu-item"
                :disabled="subtitleBusy"
                @click="loadSubtitleFile"
              >
                {{ subtitleBusy ? '正在读取…' : '从文件选择字幕…' }}
              </button>
            </div>
          </div>

          <!-- 跳过片头片尾：仿腾讯视频，把播放头拖到分界点再「设为当前」 -->
          <div class="player__tool">
            <button
              class="player__btn"
              :class="{ 'is-active': skipConfigured }"
              title="跳过片头片尾"
              @click="toggleMenu('skip')"
            >
              <svg viewBox="0 0 24 24" width="20" height="20">
                <path d="M5.5 5.5v13l9.5-6.5z" fill="currentColor" />
                <rect x="16.6" y="5.5" width="2.4" height="13" rx="1.1" fill="currentColor" />
                <path
                  d="M3.4 3.6h17.2"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.7"
                  stroke-linecap="round"
                />
              </svg>
              <span v-if="skipConfigured" class="player__badge-dot"></span>
            </button>

            <div v-if="menu === 'skip'" class="player__menu player__menu--wide">
              <p class="player__menu-title">跳过片头片尾</p>

              <div class="player__skip-row">
                <span class="player__skip-label">片头结束</span>
                <span class="player__skip-value" data-skip="intro">
                  {{ formatSkipPoint(skipIntroEnd) }}
                </span>
                <button class="player__skip-set" @click="setSkipPoint('intro')">设为当前</button>
              </div>
              <div class="player__skip-row">
                <span class="player__skip-label">片尾开始</span>
                <span class="player__skip-value" data-skip="outro">
                  {{ formatSkipPoint(skipOutroStart) }}
                </span>
                <button class="player__skip-set" @click="setSkipPoint('outro')">设为当前</button>
              </div>

              <div class="player__menu-split"></div>

              <button
                class="player__menu-item player__menu-item--switch"
                :class="{ 'is-active': skipAutoIntro }"
                :disabled="skipIntroEnd <= 0"
                data-skip="auto-intro"
                @click="toggleSkipAuto('intro')"
              >
                <span>自动跳过片头</span>
                <span class="player__switch" :class="{ 'is-on': skipAutoIntro }"></span>
              </button>
              <button
                class="player__menu-item player__menu-item--switch"
                :class="{ 'is-active': skipAutoOutro }"
                :disabled="skipOutroStart <= 0"
                data-skip="auto-outro"
                @click="toggleSkipAuto('outro')"
              >
                <span>自动跳过片尾</span>
                <span class="player__switch" :class="{ 'is-on': skipAutoOutro }"></span>
              </button>

              <div class="player__menu-split"></div>
              <button
                class="player__menu-item"
                :disabled="!skipConfigured"
                data-skip="clear"
                @click="clearSkip"
              >
                清除设置
              </button>
              <p v-if="!skipConfigured" class="player__menu-empty">
                把播放头拖到片头结束的位置，再点「设为当前」
              </p>
            </div>
          </div>

          <button
            v-if="hasQueue"
            class="player__text-btn"
            :class="{ 'is-open': panel === 'episodes' }"
            title="选集"
            @click="togglePanel('episodes')"
          >
            选集
          </button>

          <div class="player__volume">
            <button class="player__btn" :title="muted ? '取消静音' : '静音'" @click="toggleMute">
              <svg viewBox="0 0 24 24" width="20" height="20">
                <path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor" />
                <path
                  v-if="!muted"
                  d="M16 8.5a5 5 0 0 1 0 7"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.8"
                  stroke-linecap="round"
                />
                <path
                  v-if="!muted"
                  d="M18.5 6a8.5 8.5 0 0 1 0 12"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.8"
                  stroke-linecap="round"
                />
                <path
                  v-else
                  d="M16.5 9.5l5 5m0-5l-5 5"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.8"
                  stroke-linecap="round"
                />
              </svg>
            </button>
            <input
              v-model.number="volume"
              class="player__slider"
              type="range"
              min="0"
              max="1"
              step="0.02"
              @input="onVolumeChange"
            />
          </div>

          <button class="player__btn" title="画中画" @click="togglePip">
            <svg viewBox="0 0 24 24" width="20" height="20">
              <rect x="3" y="5" width="18" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="1.8" />
              <rect x="12" y="11" width="7" height="5" rx="1" fill="currentColor" />
            </svg>
          </button>

          <button class="player__btn" title="全屏" @click="toggleFullscreen">
            <svg viewBox="0 0 24 24" width="20" height="20">
              <path
                d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
        </div>
      </div>
    </transition>
  </div>
</template>

<style scoped>
.player {
  position: relative;
  width: 100%;
  height: 100%;
  background: #000;
  overflow: hidden;
}

.player__video {
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #000;
  cursor: pointer;
}

/* 加载遮罩：spinner + 文案 + 速度/缓冲读数 */
.player__loading {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 16px 22px;
  border-radius: 14px;
  background: rgba(12, 14, 18, 0.55);
  backdrop-filter: blur(10px) saturate(140%);
  color: #fff;
  text-align: center;
  /* 遮罩不能拦住播放/暂停的点击 */
  pointer-events: none;
}

.player__spinner {
  width: 34px;
  height: 34px;
  border: 3px solid rgba(255, 255, 255, 0.25);
  border-top-color: #fff;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.player__loading-label {
  margin: 0;
  font-size: 13px;
  color: rgba(255, 255, 255, 0.9);
}

.player__loading-stats {
  margin: 0;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: rgba(255, 255, 255, 0.62);
}

.player__loading-speed {
  color: #7fb4ff;
}

.player__loading-dot {
  margin: 0 5px;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.player__prepare {
  position: absolute;
  top: 50%;
  left: 50%;
  width: min(420px, calc(100% - 64px));
  transform: translate(-50%, -50%);
  padding: 18px 20px;
  border-radius: 14px;
  background: rgba(18, 20, 26, 0.82);
  backdrop-filter: blur(18px) saturate(160%);
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: #fff;
  text-align: center;
}

.player__prepare-label {
  margin: 0 0 12px;
  font-size: 13px;
  line-height: 1.6;
  color: rgba(255, 255, 255, 0.82);
}

.player__prepare-track {
  height: 4px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.18);
  overflow: hidden;
}

.player__prepare-bar {
  height: 100%;
  border-radius: 2px;
  background: var(--accent, #4f8cff);
  transition: width 0.3s ease;
}

.player__prepare-bar--indet {
  animation: slide 1.4s ease-in-out infinite;
}

@keyframes slide {
  0% {
    margin-left: -30%;
  }
  100% {
    margin-left: 100%;
  }
}

.player__prepare-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 12px;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.66);
}

.player__prepare-cancel {
  border: none;
  background: transparent;
  color: rgba(255, 255, 255, 0.66);
  font-size: 12px;
  cursor: pointer;
  text-decoration: underline;
}

.player__prepare-cancel:hover {
  color: #fff;
}

.player__error,
.player__empty {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  color: rgba(255, 255, 255, 0.72);
  font-size: 14px;
  text-align: center;
  padding: 0 24px;
}

.player__error {
  max-width: 520px;
  line-height: 1.7;
}

.player__error-action {
  margin-top: 14px;
  padding: 8px 16px;
  border: none;
  border-radius: 9px;
  background: var(--accent, #4f8cff);
  color: #fff;
  font-size: 13px;
  cursor: pointer;
  transition: filter 0.15s ease;
}

.player__error-action:hover {
  filter: brightness(1.08);
}

.player__controls {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 24px 16px 12px;
  background: linear-gradient(to top, rgba(0, 0, 0, 0.78), rgba(0, 0, 0, 0));
}

.player__progress {
  position: relative;
  padding: 8px 0;
  cursor: pointer;
  /* 拖动时别让指针滑出轨道就丢失事件 */
  touch-action: none;
}

.player__progress-track {
  position: relative;
  height: 4px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.24);
}

/* 已缓冲区间：比轨道亮、比已播放暗，一眼看出「加载到哪了」 */
.player__progress-buffered {
  position: absolute;
  top: 0;
  z-index: 1;
  height: 100%;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.42);
  transition: width 0.2s linear, left 0.2s linear;
}

.player__progress-played {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 2;
  height: 100%;
  border-radius: 2px;
  background: var(--accent, #4f8cff);
}

.player__progress-thumb {
  position: absolute;
  top: 50%;
  z-index: 3;
  width: 12px;
  height: 12px;
  margin: -6px 0 0 -6px;
  border-radius: 50%;
  background: #fff;
  transition: transform 0.12s ease;
}

.player__progress:hover .player__progress-thumb {
  transform: scale(1.2);
}

/* 悬停/拖动时的时间气泡 */
.player__progress-tip {
  position: absolute;
  bottom: 20px;
  transform: translateX(-50%);
  padding: 3px 7px;
  border-radius: 6px;
  background: rgba(12, 14, 18, 0.86);
  color: #fff;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  pointer-events: none;
}

.player__bar {
  display: flex;
  align-items: center;
  gap: 10px;
  color: #fff;
}

.player__spacer {
  flex: 1;
}

.player__btn {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: #fff;
  cursor: pointer;
  transition: background 0.15s ease;
}

.player__btn:hover {
  background: rgba(255, 255, 255, 0.14);
}

.player__time {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: rgba(255, 255, 255, 0.86);
}

.player__volume {
  display: flex;
  align-items: center;
  gap: 6px;
}

.player__slider {
  width: 84px;
  accent-color: var(--accent, #4f8cff);
}

.player__btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.player__btn:disabled:hover {
  background: transparent;
}

.player__btn.is-active {
  color: var(--accent, #4f8cff);
}

/* 字幕开着时按钮右上角点一个小圆点，不看菜单也知道当前状态 */
.player__badge-dot {
  position: absolute;
  top: 5px;
  right: 5px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--accent, #4f8cff);
}

/* 文字按钮：倍速 / 清晰度 / 选集 */
.player__text-btn {
  height: 28px;
  padding: 0 10px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: #fff;
  font-size: 12.5px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}

.player__text-btn:hover,
.player__text-btn.is-open {
  background: rgba(255, 255, 255, 0.14);
}

.player__text-btn.is-open {
  color: var(--accent, #4f8cff);
}

/* 每个带浮层的控件单独定位，菜单才能贴着它的按钮弹出 */
.player__tool {
  position: relative;
  display: flex;
  align-items: center;
}

.player__menu {
  position: absolute;
  right: 0;
  bottom: calc(100% + 8px);
  z-index: 6;
  min-width: 108px;
  max-height: 240px;
  padding: 6px;
  border-radius: 10px;
  background: rgba(20, 22, 28, 0.94);
  backdrop-filter: blur(12px) saturate(140%);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.45);
  overflow-y: auto;
}

.player__menu--wide {
  min-width: 208px;
  max-width: 280px;
  /* 字幕与跳过两张大菜单都要容得下，否则会从中间截断 */
  max-height: 330px;
}

.player__menu-title {
  margin: 2px 4px 6px;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.5);
}

.player__menu-split {
  height: 1px;
  margin: 5px 4px;
  background: rgba(255, 255, 255, 0.12);
}

.player__menu-item {
  display: block;
  width: 100%;
  padding: 7px 9px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: rgba(255, 255, 255, 0.88);
  font-size: 12.5px;
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease;
}

.player__menu-item:hover {
  background: rgba(255, 255, 255, 0.12);
}

.player__menu-item.is-active {
  color: var(--accent, #4f8cff);
}

.player__menu-item:disabled {
  opacity: 0.5;
  cursor: default;
}

.player__menu-item--sub {
  color: rgba(255, 255, 255, 0.7);
}

.player__menu-empty {
  margin: 2px 4px;
  font-size: 11.5px;
  color: rgba(255, 255, 255, 0.45);
}

/* --- 跳过片头片尾 --- */

.player__skip-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 6px;
}

.player__skip-label {
  flex-shrink: 0;
  color: rgba(255, 255, 255, 0.6);
  font-size: 12px;
}

.player__skip-value {
  flex: 1;
  color: #fff;
  font-size: 12.5px;
  font-variant-numeric: tabular-nums;
}

.player__skip-set {
  flex-shrink: 0;
  height: 24px;
  padding: 0 9px;
  border: none;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.14);
  color: #fff;
  font-size: 11.5px;
  cursor: pointer;
  transition: background 0.12s ease;
}

.player__skip-set:hover {
  background: rgba(255, 255, 255, 0.26);
}

/* 带开关的菜单项：文字在左、开关在右 */
.player__menu-item--switch {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.player__switch {
  position: relative;
  flex-shrink: 0;
  width: 30px;
  height: 17px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.22);
  transition: background 0.16s ease;
}

.player__switch::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 13px;
  height: 13px;
  border-radius: 50%;
  background: #fff;
  transition: transform 0.16s ease;
}

.player__switch.is-on {
  background: var(--accent, #4f8cff);
}

/* 开关的终态由 `.is-on` 这个类直接给出（不是靠过渡跑到终点），
   所以窗口被遮挡、过渡不推进时，位置依然是「已打开」的样子。 */
.player__switch.is-on::after {
  transform: translateX(13px);
}

/**
 * 浮出的「跳过片头 / 跳过片尾」。
 *
 * 刻意**不放在控制栏里**：控制栏 2.6 秒后自动收起，而片头通常有几十秒 ——
 * 按钮跟着一起消失就等于点不到。这里固定贴在控制栏上方，独立显隐。
 */
.player__skip {
  position: absolute;
  right: 24px;
  bottom: 104px;
  z-index: 7;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 34px;
  padding: 0 16px;
  border: 1px solid rgba(255, 255, 255, 0.22);
  border-radius: 999px;
  background: rgba(12, 14, 18, 0.74);
  color: #fff;
  font-size: 13px;
  cursor: pointer;
  backdrop-filter: blur(8px) saturate(140%);
  animation: skip-in 0.2s ease;
  transition: background 0.15s ease, border-color 0.15s ease;
}

.player__skip:hover {
  background: rgba(30, 34, 42, 0.9);
  border-color: var(--accent, #4f8cff);
}

.player__skip-time {
  color: rgba(255, 255, 255, 0.62);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

/* 与别处一致：入场只动 opacity，底座样式就是终态 */
@keyframes skip-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

/* 「点击播放」补救入口：只在自动播放真的被拦下时出现 */
.player__autoplay {
  position: absolute;
  top: 50%;
  left: 50%;
  /* ⚠️ 居中靠 transform：入场动画只能动 opacity，别再往里掺 transform */
  transform: translate(-50%, -50%);
  z-index: 8;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 20px 26px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 18px;
  background: rgba(12, 14, 18, 0.72);
  color: #fff;
  font-size: 13px;
  letter-spacing: 0.06em;
  cursor: pointer;
  backdrop-filter: blur(14px) saturate(150%);
  transition: background 0.18s ease, border-color 0.18s ease, scale 0.18s ease;
  animation: autoplay-in 0.24s ease;
}

.player__autoplay:hover {
  background: rgba(26, 30, 38, 0.86);
  border-color: var(--accent, #4f8cff);
  scale: 1.04;
}

.player__autoplay-icon {
  display: grid;
  place-items: center;
  width: 58px;
  height: 58px;
  border-radius: 50%;
  background: var(--accent, #4f8cff);
  color: #fff;
  padding-left: 4px;
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.42);
}

.player__autoplay-text {
  color: rgba(255, 255, 255, 0.86);
}

@keyframes autoplay-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

/* 选集面板 */
.player__panel {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 20;
  display: flex;
  flex-direction: column;
  width: min(340px, 78%);
  background: rgba(16, 18, 23, 0.92);
  backdrop-filter: blur(14px) saturate(150%);
  box-shadow: -12px 0 32px rgba(0, 0, 0, 0.42);
  /* 入场动画见文件下方的 panel-in —— 刻意不用 <Transition> 的 enter-from */
  animation: panel-in 0.24s cubic-bezier(0.16, 1, 0.3, 1);
}

.player__panel-head {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 16px 14px 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.09);
}

.player__panel-meta {
  flex: 1;
  min-width: 0;
}

.player__panel-title {
  margin: 0;
  font-size: 14px;
  color: #fff;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.player__panel-sub {
  margin: 4px 0 0;
  font-size: 11.5px;
  color: rgba(255, 255, 255, 0.5);
}

.player__panel-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: rgba(255, 255, 255, 0.8);
  cursor: pointer;
  transition: background 0.15s ease;
}

.player__panel-close:hover {
  background: rgba(255, 255, 255, 0.14);
}

.player__panel-body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(84px, 1fr));
  align-content: start;
  gap: 8px;
  padding: 14px;
  overflow-y: auto;
}

.player__ep {
  height: 34px;
  padding: 0 8px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.06);
  color: rgba(255, 255, 255, 0.86);
  font-size: 12.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
  transition: background 0.14s ease, border-color 0.14s ease, color 0.14s ease;
}

.player__ep:hover {
  border-color: var(--accent, #4f8cff);
  color: #fff;
}

.player__ep--active {
  border-color: var(--accent, #4f8cff);
  background: color-mix(in srgb, var(--accent, #4f8cff) 26%, transparent);
  color: #fff;
}

/* 字幕提示条：贴在控制栏上方，不挡画面中心 */
.player__notice {
  position: absolute;
  left: 50%;
  bottom: 92px;
  transform: translateX(-50%);
  z-index: 6;
  margin: 0;
  padding: 6px 14px;
  border-radius: 999px;
  background: rgba(12, 14, 18, 0.78);
  color: rgba(255, 255, 255, 0.92);
  font-size: 12px;
  white-space: nowrap;
  pointer-events: none;
}

/**
 * 入场一律走 @keyframes，**不用** Vue <Transition> 的 `enter-from`。
 *
 * Vue 摘掉 `enter-from` 靠 `requestAnimationFrame`；窗口被其它窗口遮住时
 * Chromium 会停掉帧生产，rAF 整帧不回调 —— `enter-from` 于是永远摘不掉。
 * 面板实测就卡在 `transform: matrix(1,0,0,1,340,0)`（= translateX(100%)）、
 * `opacity: 0.4`：DOM 里查得到、断言全过，用户却什么都看不到。
 *
 * 换成 @keyframes 后由**时间轴**驱动，且底座样式就是「已就位」的终态：
 * 哪怕一帧都没画，等窗口重新可见时动画早已越过 240ms，落点仍是终态。
 */
@keyframes panel-in {
  from {
    transform: translateX(100%);
    opacity: 0.4;
  }
  to {
    transform: translateX(0);
    opacity: 1;
  }
}

/* 只保留退场：入场交给上面的 @keyframes */
.slide-panel-leave-active {
  transition: transform 0.24s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.24s ease;
}

.slide-panel-leave-to {
  transform: translateX(100%);
  opacity: 0.4;
}

/* 同理：淡入用 @keyframes，否则加载遮罩 / 控制栏会卡在 `opacity: 0` 上变透明。
   注意 keyframes 里**只动 opacity** —— `.player__prepare` 等靠 translate 居中，
   掺进 transform 会把居中顶掉。 */
@keyframes fade-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

.fade-enter-active {
  animation: fade-in 0.2s ease;
}

.fade-leave-active {
  transition: opacity 0.2s ease;
}

.fade-leave-to {
  opacity: 0;
}
</style>
