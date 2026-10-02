/**
 * libuv 的线程池默认只有 4 个线程，会把 sharp（缩略图）的并行度锁死在 4 —— 这是导入慢的
 * 真正原因。实测（12 核，500 张 / 1.6GB）：设成 12 之后导入 7.4 秒 → 5.1 秒，
 * CPU 占用 3.85 核 → 6.62 核（峰值 10.7）。光把 JS 层并发调高完全没用。
 *
 * ⚠️ 必须在任何异步操作之前设置：线程池一旦创建，再改这个环境变量就不生效了。
 */
if (!process.env.UV_THREADPOOL_SIZE) {
  // 用 NUMBER_OF_PROCESSORS（Windows 自带）而不是 os.cpus()：这里在 import 之前执行，
  // 不能依赖模块导入提升，否则可能拿到 undefined。
  const cores = Number(process.env.NUMBER_OF_PROCESSORS) || 8
  process.env.UV_THREADPOOL_SIZE = String(Math.max(8, Math.min(16, cores)))
}

import { dirname, join } from 'node:path'
import { X509Certificate } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray } from 'electron'
import {
  APP_NAME,
  PROTOCOL_VERSION,
  type AppStatus,
  type ChooseDataDirResult,
  type DragPrepareResult,
  type ExportQuery,
  type MergeResult,
  type SplitResult,
  type TaskProgress
} from '@shared/types'
import { applyRuntimePaths, appRootDir, resolveDataDirWithSource, writeConfiguredDataDir } from './hub/config'
import { ensureStorage, seedBundledAssets, videoThumbPath, type StoragePaths } from './hub/storage'
import { Database } from './hub/db'
import { startHub, type HubHandle } from './hub'
import { importFolder } from './hub/importer'
import { exportTo } from './hub/exporter'
import { processPendingThumbs } from './hub/thumbs'
import { thumbPool } from './hub/thumb-pool'
import { cleanupDragStaging, prepareDragFiles, startNativeDrag } from './drag'
import { loadOrCreateHubToken, tightenHubTokenPermissions } from './hub/auth'
import { loadOrCreateHubTls, type HubTlsCredentials } from './hub/tls'
import { initLogger, log, logError, summarizePath } from './logger'

/** 拖拽中转文件的保留时长（硬链接不占空间，但也不能无限攒） */
const DRAG_STAGING_MAX_AGE_MS = 24 * 60 * 60 * 1000
const MAX_VIDEO_THUMB_BYTES = 16 * 1024 * 1024

const dataResolution = resolveDataDirWithSource()
const dataDir = dataResolution.dataDir
initLogger(dataDir)
log('info', 'startup.data_dir_resolved', {
  source: dataResolution.source,
  packaged: app.isPackaged,
  portable: Boolean(process.env.PORTABLE_EXECUTABLE_DIR),
  installRoot: summarizePath(appRootDir()),
  dataDir: summarizePath(dataDir)
})
applyRuntimePaths(dataDir)

process.on('uncaughtException', (error) => {
  logError('process.uncaught_exception', error)
})
process.on('unhandledRejection', (reason) => {
  logError('process.unhandled_rejection', reason)
})

let mainWindow: BrowserWindow | null = null
let db: Database | null = null
let paths: StoragePaths | null = null
let hub: HubHandle | null = null
let startupError = ''
let taskCounter = 0
let hubToken = ''
let hubTls: HubTlsCredentials | null = null
let tray: Tray | null = null
let isQuitting = false

function send(channel: string, payload?: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function createTray(): void {
  if (tray) return
  // 打包后的 buildResources 不会自动放进 asar，显式复制一份托盘图标到 resources/assets。
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'assets', 'tray.png')
    : join(process.cwd(), 'build', 'icon.png')
  const icon = nativeImage.createFromPath(iconPath)
  if (icon.isEmpty()) {
    console.error('[tray] 托盘图标加载失败')
    return
  }
  try {
    const nextTray = new Tray(icon)
    tray = nextTray
    nextTray.setToolTip(APP_NAME)
    nextTray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '打开 Neko_Spark', click: showMainWindow },
        {
          label: '打开相册仓库',
          click: () => void shell.openPath(paths?.dataDir ?? dataDir)
        },
        { type: 'separator' },
        {
          label: '退出 Neko_Spark',
          click: () => {
            isQuitting = true
            app.quit()
          }
        }
      ])
    )
    nextTray.on('click', showMainWindow)
  } catch (error) {
    // 没有系统托盘的桌面环境仍应保留主界面和 Hub，不让托盘初始化拖垮应用启动。
    console.error('[tray] 创建托盘失败:', error instanceof Error ? error.message : String(error))
    tray = null
  }
}

function buildStatus(): AppStatus {
  return {
    appName: APP_NAME,
    appVersion: app.getVersion(),
    protocolVersion: PROTOCOL_VERSION,
    hubToken,
    hubCertFingerprint: hubTls?.fingerprint ?? '',
    dataDir: paths?.dataDir ?? dataDir,
    dbPath: paths?.dbPath ?? '',
    runtimeDir: join(paths?.dataDir ?? dataDir, 'runtime'),
    stickersDir: paths?.stickersDir ?? join(dataDir, 'stickers'),
    backgroundVersion: (() => {
      try {
        const root = paths?.dataDir ?? dataDir
        const files = [1, 2, 3, 4].map((n) => join(root, `background-${n}.webp`)).concat(join(root, 'background.webp'))
        return files.reduce((sum, file) => (existsSync(file) ? sum + statSync(file).mtimeMs : sum), 0)
      } catch {
        return 0
      }
    })(),
    counts: db?.counts() ?? { devices: 0, albums: 0, media: 0, blobs: 0, trash: 0 },
    hub: hub?.status ?? {
      running: false,
      host: '0.0.0.0',
      port: 0,
      addresses: [],
      error: startupError || undefined
    }
  }
}

/**
 * 随安装包发布的素材目录（空状态大插画、贴图、素材原图）。
 * 打包后：<安装目录>/resources/assets/（electron-builder.yml 的 extraResources）
 * 开发时：仓库根的 GalleryMirrorData/（与开发数据目录 desktop/.data 不是同一个）
 */
function bundledAssetsDir(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'assets')
  return join(process.cwd(), '..', 'GalleryMirrorData')
}

async function bootstrap(): Promise<void> {
  try {
    log('info', 'startup.bootstrap_begin', {
      dataDir: summarizePath(dataDir),
      dataDirExists: existsSync(dataDir),
      installRoot: summarizePath(appRootDir())
    })
    paths = ensureStorage(dataDir)
    // 把当前数据仓库登记到安装目录和用户级指针；换安装目录升级时仍能找回原库。
    if (app.isPackaged) writeConfiguredDataDir(paths.dataDir)
    // 必须在建库/起 hub 之前播种：否则首屏拉 /background/:n 会 404，
    // 前端把 null 缓存下来，这一轮就看不到插画了（要重启才补上）。
    const seeded = seedBundledAssets(paths, bundledAssetsDir())
    if (seeded > 0) {
      log('info', 'startup.assets_seeded', { count: seeded })
      console.log(`[assets] 已补齐内置素材 ${seeded} 个`)
    }
    db = new Database(paths.dbPath)
    hubToken = loadOrCreateHubToken(paths.dataDir)
    tightenHubTokenPermissions(paths.dataDir)
    hubTls = await loadOrCreateHubTls(paths.dataDir)
    hub = await startHub({
      db,
      paths,
      authToken: hubToken,
      tls: hubTls,
      version: app.getVersion(),
      port: Number(process.env.GALLERY_MIRROR_PORT) || undefined,
      onDataChanged: () => send('data:changed'),
      onTaskProgress: (progress) => send('task:progress', progress),
      onSyncProgress: (progress) => send('sync:progress', progress),
      onPairingRequested: () => send('pairing:requested'),
      onPairing: () => send('pairing:completed')
    })
    log('info', 'startup.hub_started', {
      port: hub.status.port,
      addressCount: hub.status.addresses.length,
      dataDir: summarizePath(paths.dataDir),
      runtimeDir: summarizePath(join(paths.dataDir, 'runtime'))
    })
    console.log(`[hub] 已启动，端口 ${hub.status.port}`)

    // 启动后补齐上次未完成的缩略图
    void processPendingThumbs(db, paths.blobsDir, paths.thumbsDir).then((count) => {
      if (count > 0) send('data:changed')
    })

    // 清掉上次遗留的拖拽中转文件（回收站的到期清理在 startHub 里，启动时也会跑一次）
    void cleanupDragStaging(paths.tmpDir, DRAG_STAGING_MAX_AGE_MS)
  } catch (err) {
    startupError = err instanceof Error ? err.message : String(err)
    logError('startup.bootstrap_failed', err, {
      dataDir: summarizePath(dataDir),
      installRoot: summarizePath(appRootDir())
    })
    console.error('[hub] 启动失败，详细信息已写入本地诊断日志')
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f2f8ff',
    title: APP_NAME,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('close', (event) => {
    if (isQuitting) return
    // 关闭窗口只隐藏到托盘，避免用户以为 Hub 已经停止、手机同步被中断。
    event.preventDefault()
    mainWindow?.hide()
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url)
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') void shell.openExternal(url)
    } catch {
      // 不把 file:, javascript: 等协议交给系统打开器。
    }
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault()
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function installHubCertificateHandler(): void {
  app.on('certificate-error', (event, _webContents, url, _error, certificate, callback) => {
    try {
      const parsed = new URL(url)
      const localHost = parsed.protocol === 'https:' &&
        (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]' || parsed.hostname === '::1')
      const normalize = (value: string): string => value.replace(/:/g, '').toUpperCase()
      const presentedFingerprint = new X509Certificate(certificate.data).fingerprint256
      if (localHost && hubTls && normalize(presentedFingerprint) === normalize(hubTls.fingerprint)) {
        event.preventDefault()
        callback(true)
        return
      }
    } catch {
      // 其他证书错误继续交给 Chromium 拒绝。
    }
    callback(false)
  })
}

function registerIpc(): void {
  ipcMain.handle('app:status', () => buildStatus())

  ipcMain.handle('app:refreshPairingCode', () => {
    hub?.refreshPairingCode()
    return buildStatus()
  })

  ipcMain.handle('app:openDataDir', async () => {
    const dir = paths?.dataDir ?? dataDir
    return shell.openPath(dir)
  })

  ipcMain.handle('app:openStickersDir', async () => {
    const dir = paths?.stickersDir ?? join(dataDir, 'stickers')
    return shell.openPath(dir)
  })

  ipcMain.handle('app:chooseDataDir', async (): Promise<ChooseDataDirResult> => {
    const current = paths?.dataDir ?? dataDir
    const options = {
      title: '选择相册仓库目录（建议放在空间充足的 D 盘）',
      defaultPath: current,
      properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[]
    }
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options)

    if (result.canceled || result.filePaths.length === 0) {
      return { dataDir: current, changed: false }
    }
    const picked = result.filePaths[0]
    if (picked === current) return { dataDir: current, changed: false }
    writeConfiguredDataDir(picked)
    return { dataDir: picked, changed: true }
  })

  ipcMain.handle('app:restart', () => {
    app.relaunch()
    app.exit(0)
  })

  ipcMain.handle('app:pickFolder', async (_event, title?: string): Promise<string | null> => {
    const options = {
      title: title || '选择文件夹',
      properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[]
    }
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle(
    'task:importFolder',
    async (_event, dir: string, deviceId?: string): Promise<TaskProgress> => {
      if (!db || !paths) throw new Error('服务未初始化')
      taskCounter += 1
      const taskId = `import-${Date.now()}-${taskCounter}`
      const progress = await importFolder(
        {
          db,
          blobsDir: paths.blobsDir,
          thumbsDir: paths.thumbsDir,
          excludedDir: paths.dataDir,
          onProgress: (p) => send('task:progress', p)
        },
        dir,
        taskId,
        deviceId
      )
      send('data:changed')
      return progress
    }
  )

  ipcMain.handle(
    'task:exportTo',
    async (_event, targetDir: string, query: ExportQuery): Promise<TaskProgress> => {
      if (!db || !paths) throw new Error('服务未初始化')
      taskCounter += 1
      const taskId = `export-${Date.now()}-${taskCounter}`
      return exportTo(
        {
          db,
          blobsDir: paths.blobsDir,
          onProgress: (p) => send('task:progress', p)
        },
        targetDir,
        query,
        taskId
      )
    }
  )

  ipcMain.handle(
    'task:mergeDevices',
    async (_event, sourceDeviceId: string, targetDeviceId: string): Promise<MergeResult> => {
      if (!db) throw new Error('服务未初始化')
      // 可逆合并：只调整归属关系，媒体保留原始设备标签，随时可以分离
      const { mediaCount } = db.mergeDevices(sourceDeviceId, targetDeviceId)
      send('data:changed')
      return { sourceDeviceId, targetDeviceId, mediaCount }
    }
  )

  ipcMain.handle('task:splitDevice', async (_event, deviceId: string): Promise<SplitResult> => {
    if (!db) throw new Error('服务未初始化')
    const { detached } = db.splitDevice(deviceId)
    send('data:changed')
    return { deviceId, detached }
  })

  /**
   * 拖出前的准备（可单独调用/可测）：把媒体落成带原始扩展名的真实文件，返回真实路径。
   * 界面走的是下面的 dragOut，测试走这个 —— 因为 dragOut 会进入系统模态拖放循环，测试会被卡住。
   */
  ipcMain.handle('media:prepareDrag', async (_event, ids: number[]): Promise<DragPrepareResult> => {
    if (!db || !paths) throw new Error('服务未初始化')
    return prepareDragFiles(db, paths, ids ?? [])
  })

  /**
   * 视频首帧缩略图落盘（渲染端抽好帧、编成 webp 之后送进来）。
   *
   * ⚠️ 主进程在这里**不做任何视频解码** —— 只是"校验看起来是 webp → 原子落盘 → 标记 ready"。
   * 视频解码交给渲染端的 Chromium（它本来就在播这些视频，能力边界一致、不会把主进程带走）。
   */
  ipcMain.handle(
    'media:saveVideoThumb',
    async (_event, id: number, bytes: ArrayBuffer): Promise<boolean> => {
      if (!db || !paths) throw new Error('服务未初始化')
      const media = db.getMediaAny(Number(id))
      if (!media || media.kind !== 'video') return false
      if (!(bytes instanceof ArrayBuffer) || bytes.byteLength > MAX_VIDEO_THUMB_BYTES) return false
      const buffer = Buffer.from(bytes ?? new ArrayBuffer(0))
      if (buffer.length < 32) return false
      // RIFF....WEBP 魔数：别让垃圾字节混进缩略图目录
      if (
        buffer.subarray(0, 4).toString('ascii') !== 'RIFF' ||
        buffer.subarray(8, 12).toString('ascii') !== 'WEBP'
      ) {
        return false
      }
      const target = videoThumbPath(paths.thumbsDir, media.blobSha256)
      await mkdir(dirname(target), { recursive: true })
      const tmp = `${target}.tmp`
      await writeFile(tmp, buffer)
      await rename(tmp, target)
      db.setThumbState(media.id, 'ready')
      send('data:changed')
      return true
    }
  )

  /** 抽帧失败（Chromium 解不了这个编码）：记 failed，界面继续显示播放占位，别再反复试 */
  ipcMain.handle('media:videoThumbFailed', (_event, id: number) => {
    if (!db) return
    db.setThumbState(Number(id), 'failed')
    send('data:changed')
  })

  /** 开始原生拖放（渲染端 dragstart 里调用，只复制不移动） */
  ipcMain.on('media:dragOut', (event, ids: number[]) => {
    if (!db || !paths) return
    const targetIds = ids ?? []
    // 顺手清一遍过期中转文件（24 小时前的；刚创建的那次拖拽不会被碰到）
    void cleanupDragStaging(paths.tmpDir, DRAG_STAGING_MAX_AGE_MS)
    void startNativeDrag(event, db, paths, targetIds).catch((err: unknown) => {
      // 拖拽失败不影响其它功能，用户再拖一次即可；但要留一行日志，方便排查"拖不出去"
      console.error('[drag] 拖出失败:', err instanceof Error ? err.message : String(err))
    })
  })
}

app.whenReady().then(async () => {
  registerIpc()
  await bootstrap()
  installHubCertificateHandler()
  createWindow()
  createTray()

  if (startupError) {
    dialog.showErrorBox('本地服务启动失败', startupError)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  isQuitting = true
})

app.on('will-quit', () => {
  tray?.destroy()
  tray = null
  thumbPool.shutdown()
  void hub?.stop()
  try {
    db?.close()
  } catch {
    // 退出阶段忽略关闭异常
  }
})
