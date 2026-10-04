/**
 * 回收冒烟测试残留的 Electron 进程。
 *
 * 正常路径下冒烟脚本会先通过 CDP 的 Browser.close 让应用优雅退出，再用 taskkill /T 兜底；
 * 但如果应用异常崩溃（主进程先退出），renderer 子进程会被 reparent，`taskkill /T` 就抓不到它们，
 * 这些进程会持续空转、累积后拖垮整机。
 *
 * 安全边界：**只回收命令行里出现过 `.smoke` 的进程**，
 * 也就是只针对测试用的隔离 userData 目录，绝不会碰用户自己打开的 CinePlayer 窗口。
 *
 * 运行：npm run clean
 */
import { spawn } from 'node:child_process'

/**
 * 起一个一次性子进程并等它结束。
 *
 * 必须用**异步** spawn：部分受限环境（沙箱 / 作业对象）会拒绝同步创建进程，
 * `spawnSync` 直接抛 EBUSY，回收动作就静默失效了 —— 而残留的 renderer 会持续空转。
 */
function run(cmd, args) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, { windowsHide: true })
    } catch {
      resolve({ failed: true, stdout: '', stderr: '' })
      return
    }
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => (stdout += chunk))
    child.stderr?.on('data', (chunk) => (stderr += chunk))
    child.on('error', () => resolve({ failed: true, stdout, stderr }))
    child.on('close', () => resolve({ failed: false, stdout, stderr }))
  })
}

const isWindows = process.platform === 'win32'

if (isWindows) {
  const script = [
    // PowerShell 默认用系统代码页输出，中文会乱码
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$OutputEncoding = [System.Text.Encoding]::UTF8',
    "$targets = Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" -ErrorAction SilentlyContinue |",
    "  Where-Object { $_.CommandLine -and $_.CommandLine -like '*\\.smoke*' }",
    'if (-not $targets) { Write-Output "没有需要回收的测试进程"; exit 0 }',
    'foreach ($t in $targets) {',
    '  Write-Output ("回收 PID {0}" -f $t.ProcessId)',
    '  Stop-Process -Id $t.ProcessId -Force -ErrorAction SilentlyContinue',
    '}'
  ].join('\n')

  const result = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script])
  if (result.failed) {
    console.error('调用 PowerShell 失败（未回收任何进程）')
    process.exit(1)
  }
  process.stdout.write(result.stdout ?? '')
  if (result.stderr) process.stderr.write(result.stderr)
  process.exit(0)
}

// macOS / Linux：按命令行关键字匹配
const listed = await run('pgrep', ['-f', 'electron.*\\.smoke'])
const pids = (listed.stdout ?? '')
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean)

if (!pids.length) {
  console.log('没有需要回收的测试进程')
  process.exit(0)
}
for (const pid of pids) {
  console.log(`回收 PID ${pid}`)
  try {
    process.kill(Number(pid), 'SIGKILL')
  } catch {
    /* ignore */
  }
}
