/**
 * 跳过片头片尾 —— 纯逻辑层。
 *
 * 这里只回答「给定播放位置与配置，此刻该不该跳过」，不碰 DOM、不碰存储、
 * 不碰路由，所以主进程 / 预加载 / 渲染层都能引用，也能离线断言。
 */

/** 一集的三个时间切分点（秒）。0 一律表示「未设置」。 */
export interface SkipWindow {
  /** 片头结束点：播到这里就算进了正片 */
  introEnd: number
  /** 片尾开始点：播到这里就算进了片尾 */
  outroStart: number
}

/** 一部剧（或单个播放地址）的跳过配置 */
export interface SkipProfile extends SkipWindow {
  /** 归属 key：同一部剧的每一集共用一份 */
  key: string
  /** 片头自动跳过（不显示按钮，直接跳过去） */
  autoIntro: boolean
  /** 片尾自动跳过（有下一集时直接续播） */
  autoOutro: boolean
  updatedAt: number
}

/** 需要执行的动作；`''` 表示什么都不用做 */
export type SkipAction = '' | 'intro' | 'outro'

/**
 * 片头点与片尾点之间至少要留出的时长。
 *
 * 两点挨在一起（甚至反过来）说明至少有一个设错了 —— 那种配置下
 * 「跳过片头」会直接落到片尾区间里，一点播放就往下跳一集。
 */
export const SKIP_MIN_GAP = 5

/**
 * 判定容差（秒）。
 *
 * 「跳过片头」会跳到 `introEnd`，但落点与实际数值总有零点几秒误差
 * （关键帧对齐、seek 精度）。不留容差的话跳完立刻又判定「还在片头里」，
 * 按钮原地重新出现，看起来像点了没反应。
 */
export const SKIP_TOLERANCE = 0.4

export function emptyProfile(key: string): SkipProfile {
  return { key, introEnd: 0, outroStart: 0, autoIntro: false, autoOutro: false, updatedAt: 0 }
}

/**
 * 规整一份从库里读出来的配置。
 *
 * 只做两件事：把非法值（NaN / Infinity / 负数）归 0，以及消解自相矛盾的组合
 * （片头点没有比片尾点早够 `SKIP_MIN_GAP`）。矛盾时**丢弃片尾点、保留片头点**：
 * 片头是更常用的那一项，而且丢掉片尾最坏只是不跳片尾，反之会让「跳过片头」
 * 直接跳进片尾。
 */
export function normalizeSkipWindow(raw: Partial<SkipWindow>, duration = 0): SkipWindow {
  const cap = Number.isFinite(duration) && duration > 0 ? duration : 0
  const clamp = (value: unknown): number => {
    const num = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(num) || num <= 0) return 0
    return cap > 0 ? Math.min(num, cap) : num
  }

  const introEnd = clamp(raw.introEnd)
  let outroStart = clamp(raw.outroStart)
  if (outroStart > 0 && introEnd > 0 && introEnd >= outroStart - SKIP_MIN_GAP) outroStart = 0
  return { introEnd, outroStart }
}

/**
 * 在已有配置上设置一个端点，并自动避让另一端。
 *
 * 规则是**最后设置的那一端胜出**，与它冲突的另一端被清掉 ——
 * 用户刚拖完的那个数字才是他的真实意图，拿它去迁就一个旧值只会让人困惑。
 */
export function withSkipPoint(
  profile: SkipProfile,
  which: 'intro' | 'outro',
  seconds: number,
  duration = 0
): SkipWindow {
  const base = normalizeSkipWindow(profile, duration)
  const cap = Number.isFinite(duration) && duration > 0 ? duration : 0
  const value = Number.isFinite(seconds) && seconds > 0 ? (cap > 0 ? Math.min(seconds, cap) : seconds) : 0

  if (which === 'intro') {
    const introEnd = value
    const outroStart =
      base.outroStart > 0 && introEnd > 0 && introEnd >= base.outroStart - SKIP_MIN_GAP
        ? 0
        : base.outroStart
    return { introEnd, outroStart }
  }

  const outroStart = value
  const introEnd =
    base.introEnd > 0 && outroStart > 0 && base.introEnd >= outroStart - SKIP_MIN_GAP
      ? 0
      : base.introEnd
  return { introEnd, outroStart }
}

export interface SkipContext {
  /** 当前播放位置（秒） */
  time: number
  /** 后面还有没有下一集：没有的话片尾跳过去也无处可去 */
  canSkipOutro: boolean
}

/**
 * 当前该执行的动作。
 *
 * 这是个**电平**判定（不是边沿）：只要播放位置落在片头区间里就会持续返回 `'intro'`，
 * 于是用户手动拖回片头，按钮会重新出现 —— 那正是他可能想要的。
 * 「自动跳过」每集只触发一次这件事由调用方用闩锁处理，不在这里做。
 */
export function skipAction(
  profile: SkipProfile | null | undefined,
  context: SkipContext
): SkipAction {
  if (!profile) return ''
  const time = Number.isFinite(context.time) ? Math.max(0, context.time) : 0

  if (profile.introEnd > 0 && time < profile.introEnd - SKIP_TOLERANCE) return 'intro'
  if (profile.outroStart > 0 && context.canSkipOutro && time >= profile.outroStart - SKIP_TOLERANCE) {
    return 'outro'
  }
  return ''
}

/** 菜单里显示的时间点；未设置显示 `--:--` */
export function formatSkipPoint(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '--:--'
  const total = Math.round(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  const pad = (value: number): string => String(value).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`
}
