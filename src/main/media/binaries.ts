import { app } from 'electron'
import { existsSync } from 'fs'
import { spawnSync } from 'child_process'
import { join, sep } from 'path'

type BinaryKind = 'ffmpeg' | 'ffprobe'

interface BinarySpec {
  /** npm 平台包作用域，如 @ffmpeg-installer */
  scope: string
  /** 可执行文件名（不含扩展名） */
  name: string
  /** 允许用环境变量覆盖 */
  env: string
  /** 模块包名，用于要求可执行的版本校验 */
  moduleName: string
}

const SPECS: Record<BinaryKind, BinarySpec> = {
  ffmpeg: {
    scope: '@ffmpeg-installer',
    name: 'ffmpeg',
    env: 'CINEPLAYER_FFMPEG',
    moduleName: '@ffmpeg-installer/ffmpeg'
  },
  ffprobe: {
    scope: '@ffprobe-installer',
    name: 'ffprobe',
    env: 'CINEPLAYER_FFPROBE',
    moduleName: '@ffprobe-installer/ffprobe'
  }
}

const PLATFORM = `${process.platform}-${process.arch}`
const EXE = process.platform === 'win32' ? '.exe' : ''

/** app.asar 内的二进制无法执行，需要指向解包目录 */
function toUnpacked(candidate: string): string {
  return candidate.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`)
}

function candidatePaths(spec: BinarySpec): string[] {
  const fileName = `${spec.name}${EXE}`
  const moduleRelative = join(spec.scope, PLATFORM, fileName)
  const list: string[] = []

  if (process.env[spec.env]) list.push(process.env[spec.env] as string)

  let appPath = ''
  let resourcesPath = ''
  try {
    appPath = app.getAppPath()
    resourcesPath = process.resourcesPath
  } catch {
    /* app 尚未 ready 时忽略 */
  }

  if (appPath) {
    const unpacked = join(toUnpacked(appPath), 'node_modules', moduleRelative)
    list.push(unpacked, join(appPath, 'node_modules', moduleRelative))
  }
  if (resourcesPath) {
    list.push(join(resourcesPath, 'bin', fileName))
  }

  return list
}

/** 从 PATH 中兜底查找（用户自己装了 ffmpeg 也能用） */
function findOnPath(name: string): string | null {
  const raw = process.env.PATH ?? process.env.Path ?? ''
  for (const dir of raw.split(process.platform === 'win32' ? ';' : ':')) {
    if (!dir) continue
    const candidate = join(dir.trim(), `${name}${EXE}`)
    if (existsSync(candidate)) return candidate
  }
  return null
}

const resolved = new Map<BinaryKind, string | null>()

/**
 * 这些错误码表示「操作系统此刻拒绝启动它」，而不是「这个二进制有问题」：
 *   - EBUSY：文件被占用（另一个进程正在跑它），或运行环境禁用了同步创建进程这条路径
 *   - ETIMEDOUT：`timeout` 到点，通常是刚构建完被杀软扫描拖慢
 * 遇到它们时应当保留「文件存在」这个事实 —— 真正调用时用的是异步 spawn，
 * 那条路径不受影响，出问题会给出明确报错。早期版本把它们一律判成「不可用」，
 * 结果整个转封装 / 转码链路被静默关掉，只留下一句「没有 ffmpeg」。
 */
const TRANSIENT_SPAWN_ERRORS = new Set(['EBUSY', 'ETIMEDOUT', 'EAGAIN', 'EMFILE', 'ENFILE'])

/** 返回可用的二进制绝对路径；不可用时返回 null（结果会被缓存） */
export function resolveBinary(kind: BinaryKind): string | null {
  if (resolved.has(kind)) return resolved.get(kind) ?? null

  const spec = SPECS[kind]
  let found: string | null = null

  for (const candidate of candidatePaths(spec)) {
    if (existsSync(candidate)) {
      found = candidate
      break
    }
  }
  if (!found) found = findOnPath(spec.name)

  // 校验二进制真的能跑（架构不匹配的情况会在这一步暴露）。
  // 刚构建完时二进制可能正被杀软扫描，首次执行会明显偏慢（60MB+ 的可执行文件），
  // 单次超时会把可用环境误判为「没有 ffmpeg」，因此放宽超时并重试一次。
  if (found) {
    let ok = false
    let lastError: string | undefined
    for (let attempt = 0; attempt < 2 && !ok; attempt++) {
      const check = spawnSync(found, ['-version'], { windowsHide: true, timeout: 25000 })
      ok = !check.error && check.status === 0
      lastError = (check.error as NodeJS.ErrnoException | undefined)?.code
    }
    // 只有「确实跑不起来」（架构不匹配、非可执行文件、非零退出）才判定不可用
    if (!ok && !(lastError && TRANSIENT_SPAWN_ERRORS.has(lastError))) found = null
  }

  resolved.set(kind, found)
  return found
}

export function hasFfmpeg(): boolean {
  return resolveBinary('ffmpeg') !== null && resolveBinary('ffprobe') !== null
}

export function binaryOrigin(kind: BinaryKind): string {
  return resolveBinary(kind) ?? ''
}
