/**
 * 无人值守"覆盖安装"：把 `release/win-unpacked` 里的成品直接部署到已安装目录（默认 <项目>\app）。
 *
 * 为什么不走安装器（重要）：
 *   electron-builder 的 NSIS 安装器在 `perMachine: false` + `allowElevation: true` 下会认为
 *   "所有用户 / 仅当前用户"两种模式都支持，于是**覆盖安装时会弹一个"为哪位用户安装"的页面**，
 *   必须手点"下一步"才继续 —— `/S` 静默参数也拦不住这个页面。
 *   用户明确要求"改完自己装、不要让用户点任何东西"，所以日常部署走这个脚本：
 *   关程序 → 复制成品 → 启动 → 验证，全程没有任何窗口。
 *   （`GalleryMirror-0.1.0-安装版.exe` 仍然照常产出，给别的机器装 / 用户自己双击时用。）
 *
 * ⚠️ 为什么要连 `GalleryMirror.exe` 一起复制：electron-builder 打包时会把 app.asar 的完整性哈希
 *    写进 exe 的资源里（构建日志里的 "updating asar integrity executable resource"），
 *    只换 asar 不换 exe 有对不上的风险。反正 exe 就在同一个产物目录里，一起复制最稳。
 *
 * 用法：node scripts/deploy-installed.mjs [目标目录]
 */
import { cpSync, existsSync, statSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const projectRoot = resolve(import.meta.dirname, '..')
/**
 * 仓库根 = desktop/ 的上一级。
 * ⚠️ 部署目标 app/ 必须留在仓库根、不能跟着电脑端进 desktop/：
 *    它是"安装目录"，而数据目录 GalleryMirrorData 必须与它**同级**
 *    （src/main/hub/config.ts 的 join(dirname(exe), 'GalleryMirrorData')），
 *    而 GalleryMirrorData 又必须留在仓库根（安卓构建要从那里取贴图）。
 */
const repoRoot = resolve(projectRoot, '..')
const sourceDir = join(projectRoot, 'release', 'win-unpacked')
const targetDir = process.argv[2] ? resolve(process.argv[2]) : join(repoRoot, 'app')
const appName = 'Neko_Spark.exe'
/**
 * 改名前的老 exe 名（2026-09-25 产品名从 GalleryMirror 改成 Neko_Spark）。
 * 目标目录里出现**任意一个**都算"已经装过"，否则从老版本升级会被
 * "没有已安装的程序"挡住（而且老实例还占着 app.asar 拷不进去，得一起关掉）。
 */
const LEGACY_APP_NAMES = ['GalleryMirror.exe']
const hubPort = Number(process.env.GM_DEPLOY_PORT || 8787)
const hubPorts = [hubPort, hubPort + 1, hubPort + 2]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function fail(message) {
  console.log(`✗ ${message}`)
  process.exit(1)
}

if (!existsSync(join(sourceDir, appName))) {
  fail(`找不到成品：${join(sourceDir, appName)}\n  先跑 npm.cmd run dist:nsis（或 dist）`)
}
const installedAs = [appName, ...LEGACY_APP_NAMES].find((name) => existsSync(join(targetDir, name)))
if (!installedAs) {
  fail(`目标目录里没有已安装的程序：${targetDir}\n  （首次安装请用安装器，这个脚本只做覆盖升级）`)
}
if (installedAs !== appName) {
  console.log(`· 检测到旧版本（${installedAs}），升级后会改名为 ${appName}`)
}

// ---------- 1) 关掉正在运行的程序 ----------
// ⚠️ 新旧名字都要关：老实例占着 resources/app.asar，不关掉下面的复制会失败
const namesToStop = [appName, ...LEGACY_APP_NAMES]
const runningInstances = () => {
  const out = spawnSync('tasklist', ['/FO', 'CSV'], { encoding: 'utf-8' }).stdout ?? ''
  return namesToStop.filter((name) => out.toLowerCase().includes(name.toLowerCase()))
}
const running = () => runningInstances().length > 0

if (running()) {
  console.log('· 关闭正在运行的程序（优雅关闭）…')
  for (const name of runningInstances()) spawnSync('taskkill', ['/IM', name], { stdio: 'ignore' })
  for (let i = 0; i < 20 && running(); i += 1) await sleep(500)
  if (running()) {
    console.log('· 优雅关闭没成功，强制关闭…')
    for (const name of runningInstances()) spawnSync('taskkill', ['/IM', name, '/F'], { stdio: 'ignore' })
    for (let i = 0; i < 20 && running(); i += 1) await sleep(500)
  }
  if (running()) fail(`程序还在运行，无法替换文件（${runningInstances().join(', ')}）`)
  console.log('· 已关闭')
} else {
  console.log('· 程序本来就没在运行')
}

// ---------- 2) 复制成品（重试几次，防杀进程后文件还没释放） ----------
const files = [
  appName,
  join('resources', 'app.asar')
]
const dirs = [join('resources', 'app.asar.unpacked')]

for (let attempt = 1; attempt <= 5; attempt += 1) {
  try {
    for (const file of files) {
      const from = join(sourceDir, file)
      if (!existsSync(from)) continue
      cpSync(from, join(targetDir, file))
    }
    for (const dir of dirs) {
      const from = join(sourceDir, dir)
      if (existsSync(from)) cpSync(from, join(targetDir, dir), { recursive: true })
    }
    break
  } catch (err) {
    if (attempt === 5) fail(`复制失败：${err instanceof Error ? err.message : String(err)}`)
    console.log(`· 复制遇到占用，重试（${attempt}/5）…`)
    await sleep(1000)
  }
}
const deployedAsar = join(targetDir, 'resources', 'app.asar')
const sourceAsar = join(sourceDir, 'resources', 'app.asar')
const sameSize = statSync(deployedAsar).size === statSync(sourceAsar).size
console.log(
  `· 已复制：${appName} + resources/app.asar（${statSync(deployedAsar).size} 字节，` +
    `与成品一致：${sameSize ? '是' : '否 ⚠️'}）`
)

// ---------- 3) 启动 ----------
console.log('· 启动程序…')
spawn('cmd', ['/c', 'start', '', join(targetDir, appName)], { detached: true, stdio: 'ignore' }).unref()

// ---------- 4) 验证：Hub 起来 + 数据还在 ----------
const bases = hubPorts.map((port) => `https://127.0.0.1:${port}/api/v1`)
let info = null
let activeBase = ''
for (let i = 0; i < 60 && !info; i += 1) {
  await sleep(1000)
  for (const base of bases) {
    try {
      const res = await fetch(`${base}/info`, { signal: AbortSignal.timeout(1000) })
      if (res.ok) {
        info = await res.json()
        activeBase = base
        break
      }
    } catch {
      /* 还没起来，或候选端口尚未可用 */
    }
  }
}
if (!info) fail('程序启动了但 Hub 没起来，请检查')

console.log(`✓ 部署完成，服务已就绪（${activeBase}）`)
console.log('  数据目录: 请在桌面端设置页查看（Hub 不通过 HTTP 泄露本机路径）')
console.log(
  `  媒体 ${info.counts.media} 项 · 回收站 ${info.counts.trash} 项 · 设备 ${info.counts.devices} 个 · 内容 ${info.counts.blobs} 个`
)
