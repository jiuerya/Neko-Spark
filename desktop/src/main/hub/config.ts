import { dirname, join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { app } from 'electron'

/** 记录仓库位置的引导文件，放在程序目录（安装目录）下，不占 C 盘 */
const POINTER_FILE = 'data-location.json'

/**
 * 便携版 exe 实际所在的目录。
 *
 * 便携版是自解压到临时目录再运行的，`process.execPath` 指向那个临时目录（程序一关就没了），
 * 所以必须用 electron-builder 设的 `PORTABLE_EXECUTABLE_DIR` 才能拿到 U 盘上的真实位置。
 * 安装版/开发模式没有这个变量，返回 undefined。
 */
function portableDir(): string | undefined {
  const dir = process.env.PORTABLE_EXECUTABLE_DIR
  return dir && dir.trim() ? dir.trim() : undefined
}

/** 程序所在目录：便携版为 exe 所在目录，安装版为安装目录，开发时为项目目录 */
export function appRootDir(): string {
  const portable = portableDir()
  if (portable) return portable
  return app.isPackaged ? dirname(process.execPath) : process.cwd()
}

function pointerPath(): string {
  return join(appRootDir(), POINTER_FILE)
}

/** app.getPath() 在极早期启动阶段或某些便携环境可能暂不可用；Windows 的 APPDATA 可直接作为兜底。 */
function appDataDir(): string | undefined {
  try {
    return app.getPath('appData')
  } catch {
    const value = process.env.APPDATA?.trim()
    return value || undefined
  }
}

function fallbackUserDataDir(): string | undefined {
  try {
    return app.getPath('userData')
  } catch {
    const root = appDataDir()
    return root ? join(root, 'Neko_Spark') : undefined
  }
}

/**
 * 安装到另一个目录时，安装目录内的指针不会随新安装复制过去。
 * 再留一份用户级指针，保证同一台电脑上的覆盖更新和迁移安装继续使用原数据仓库。
 * 便携版不写这里，避免 U 盘上的多个副本互相串库。
 */
function sharedPointerPath(): string | undefined {
  if (!app.isPackaged || portableDir()) return undefined
  const root = appDataDir()
  return root ? join(root, 'Neko_Spark', POINTER_FILE) : undefined
}

function legacySharedPointerPaths(): string[] {
  const root = appDataDir()
  if (!root) return []
  return ['GalleryMirror', 'gallery-mirror', 'Neko-Spark', 'com.gallerymirror.desktop']
    .map((name) => join(root, name, POINTER_FILE))
}

/** 从旧的 per-user 安装升级为 per-machine 时，旧 HKCU 安装位置仍可能保留。 */
function registeredLegacyInstallRoots(): string[] {
  if (process.platform !== 'win32') return []
  const registryKeys = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\com.gallerymirror.desktop_is1',
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\com.gallerymirror.desktop',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\com.gallerymirror.desktop_is1',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\com.gallerymirror.desktop'
  ]
  const roots: string[] = []
  for (const key of registryKeys) {
    try {
      const output = execFileSync('reg.exe', ['query', key, '/v', 'InstallLocation'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
        timeout: 1500
      })
      const match = /^\s*InstallLocation\s+REG_(?:SZ|EXPAND_SZ)\s+(.+)$/im.exec(output)
      const value = match?.[1]?.trim()
      if (value) roots.push(value)
    } catch {
      // 没有对应的旧安装记录时继续尝试其他候选。
    }
  }
  return roots
}

function readPointer(file: string): string | undefined {
  try {
    if (!existsSync(file)) return undefined
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as { dataDir?: string }
    const dataDir = parsed.dataDir?.trim()
    // 指针指向的仓库已被移动/删除时继续走迁移候选路径，避免启动一个全新的空库覆盖用户视图。
    return dataDir && existsSync(dataDir) ? dataDir : undefined
  } catch {
    return undefined
  }
}

function legacyPointerPaths(): string[] {
  const parent = dirname(appRootDir())
  return ['GalleryMirror', 'Neko_Spark', 'Neko-Spark']
    .map((name) => join(parent, name, POINTER_FILE))
    .filter((file) => file !== pointerPath())
}

function isWritable(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true })
    const probe = join(dir, `.write-test-${process.pid}`)
    writeFileSync(probe, '')
    rmSync(probe, { force: true })
    return true
  } catch {
    return false
  }
}

/** 读取用户配置的仓库位置（环境变量优先，其次引导文件） */
export function readConfiguredDataDir(): string | undefined {
  return readConfiguredDataDirDetails()?.dataDir
}

export type DataDirResolution = {
  dataDir: string
  source: 'environment' | 'local-pointer' | 'shared-pointer' | 'legacy-shared-pointer' | 'legacy-install-pointer' | 'default'
}

function readConfiguredDataDirDetails(): DataDirResolution | undefined {
  const fromEnv = process.env.GALLERY_MIRROR_DATA
  if (fromEnv && fromEnv.trim()) return { dataDir: fromEnv.trim(), source: 'environment' }

  const local = readPointer(pointerPath())
  if (local) return { dataDir: local, source: 'local-pointer' }
  const shared = sharedPointerPath()
  const fromShared = shared ? readPointer(shared) : undefined
  if (fromShared) return { dataDir: fromShared, source: 'shared-pointer' }
  for (const legacy of legacySharedPointerPaths()) {
    const dataDir = readPointer(legacy)
    if (dataDir) return { dataDir, source: 'legacy-shared-pointer' }
  }
  for (const legacy of legacyPointerPaths()) {
    const dataDir = readPointer(legacy)
    if (dataDir) return { dataDir, source: 'legacy-install-pointer' }
  }
  return undefined
}

function looksLikeLibrary(dir: string): boolean {
  return existsSync(join(dir, 'manifest.db')) || existsSync(join(dir, 'blobs'))
}

export function writeConfiguredDataDir(dataDir: string): void {
  const payload = `${JSON.stringify({ dataDir }, null, 2)}\n`
  // 安装目录可能位于 Program Files 或被安全软件设为只读；用户级指针才是升级迁移的主路径。
  try {
    writeFileSync(pointerPath(), payload, 'utf-8')
  } catch {
    // 安装目录指针写失败不阻断 Hub 启动。
  }
  const shared = sharedPointerPath()
  if (shared) {
    try {
      mkdirSync(dirname(shared), { recursive: true })
      writeFileSync(shared, payload, 'utf-8')
    } catch {
      // 用户级配置目录不可写时保留本次运行，下一次仍可按默认/旧目录候选恢复。
    }
  }
}

/**
 * 默认仓库位置：与程序目录同级（例如装到 D:\GalleryMirror → 数据在 D:\GalleryMirrorData）。
 * 放在安装目录"外面"是为了卸载/升级时不会被卸载程序一起删掉。
 * 若同级目录不可写，才退回安装目录内，最后才退回系统用户目录。
 */
export function defaultDataDir(): string {
  if (!app.isPackaged) return join(process.cwd(), '.data')

  const root = appRootDir()

  // 便携版：数据就放在 exe 同一个文件夹里（U 盘拔了就走，真正的绿色软件）。
  // 注意不能走下面的"上一级"逻辑 —— 那会落到 U 盘根目录，不跟着这个文件夹走。
  if (portableDir()) {
    const beside = join(root, 'GalleryMirrorData')
    if (isWritable(beside)) return beside
    // U 盘只读等极端情况：退回系统用户目录，至少还能跑
    return join(fallbackUserDataDir() ?? root, 'GalleryMirrorData')
  }

  const sibling = join(dirname(root), 'GalleryMirrorData')
  const legacy = join(root, 'GalleryMirrorData') // 旧布局：在安装目录内（升级会被清掉）

  // 产品改名/安装目录改变后，旧版本的指针可能随旧安装器被删除；按已知历史目录名找回已有库。
  const parent = dirname(root)
  const historicalCandidates = [
    sibling,
    join(parent, 'Neko_SparkData'),
    join(parent, 'Neko-SparkData'),
    join(parent, 'GalleryMirror', 'GalleryMirrorData'),
    join(parent, 'Neko_Spark', 'GalleryMirrorData'),
    join(parent, 'Neko-Spark', 'GalleryMirrorData'),
    ...registeredLegacyInstallRoots().flatMap((installRoot) => [
      join(installRoot, POINTER_FILE),
      join(installRoot, 'GalleryMirrorData')
    ]),
    legacy
  ]
  for (const candidate of [...new Set(historicalCandidates)]) {
    if (candidate.endsWith(POINTER_FILE)) {
      const pointed = readPointer(candidate)
      if (pointed) return pointed
      continue
    }
    if (looksLikeLibrary(candidate)) return candidate
  }

  // 旧布局 → 新布局自动迁移
  if (!existsSync(sibling) && existsSync(legacy)) {
    try {
      renameSync(legacy, sibling)
    } catch {
      // 迁移失败就继续用旧位置，至少数据还在
    }
  }

  if (isWritable(sibling)) return sibling
  if (isWritable(legacy)) return legacy
  return join(fallbackUserDataDir() ?? root, 'GalleryMirrorData')
}

export function resolveDataDir(): string {
  return resolveDataDirWithSource().dataDir
}

export function resolveDataDirWithSource(): DataDirResolution {
  return readConfiguredDataDirDetails() ?? { dataDir: defaultDataDir(), source: 'default' }
}

/** 启动时把 Chromium 缓存、崩溃转储等运行时文件也放到仓库目录，避免写入 C 盘 */
export function applyRuntimePaths(dataDir: string): void {
  const runtime = join(dataDir, 'runtime')
  mkdirSync(runtime, { recursive: true })
  app.setPath('userData', runtime)
  try {
    app.setPath('crashDumps', join(runtime, 'crash-dumps'))
  } catch {
    // 某些平台不支持该路径，忽略
  }
}
