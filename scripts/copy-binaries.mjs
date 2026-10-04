/**
 * 打包前把 ffmpeg / ffprobe 二进制复制到 resources/bin，
 * electron-builder 会通过 extraResources 把它们放进 <app>/resources/bin，
 * 主进程（src/main/media/binaries.ts）会优先在那里查找。
 *
 * 开发模式下不需要这一步：主进程直接从 node_modules 里解析。
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const platform = `${process.platform}-${process.arch}`
const exe = process.platform === 'win32' ? '.exe' : ''

const targets = [
  { scope: '@ffmpeg-installer', name: 'ffmpeg' },
  { scope: '@ffprobe-installer', name: 'ffprobe' }
]

const outDir = join(root, 'resources', 'bin')
mkdirSync(outDir, { recursive: true })

/**
 * 内容一致就跳过。两个二进制合计 140MB+，每次构建都重写不仅慢，
 * 还会让杀软重新扫描，进而拖慢紧随其后的首次执行。
 */
function sameContent(a, b) {
  if (!existsSync(b)) return false
  const sa = statSync(a)
  const sb = statSync(b)
  return sa.size === sb.size && sa.mtimeMs <= sb.mtimeMs
}

let copied = 0
for (const target of targets) {
  const source = join(root, 'node_modules', target.scope, platform, `${target.name}${exe}`)
  if (!existsSync(source)) {
    console.warn(`[copy-binaries] 跳过 ${target.name}：未找到 ${source}`)
    continue
  }
  const destination = join(outDir, `${target.name}${exe}`)
  if (sameContent(source, destination)) {
    console.log(`[copy-binaries] ${target.name} 已是最新，跳过`)
    continue
  }
  copyFileSync(source, destination)
  copied++
  console.log(`[copy-binaries] ${target.name} -> ${destination}`)
}

console.log(`[copy-binaries] 完成，共复制 ${copied} 个二进制`)
