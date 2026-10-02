export const PROTOCOL_VERSION = 1

export const APP_NAME = 'Neko_Spark'

/** 回收站保留天数：到期后自动彻底删除（连磁盘文件一起清） */
export const TRASH_RETENTION_DAYS = 30
export const TRASH_RETENTION_MS = TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000

export type MediaKind = 'image' | 'video'

export type ThumbState = 'none' | 'pending' | 'ready' | 'failed'

/** 媒体记录（数据库中的一行，也是界面展示所需的最小集合） */
export interface MediaRecord {
  id: number
  deviceId: string
  displayName: string
  relativePath: string
  bucketId: string
  bucketName: string
  kind: MediaKind
  mime: string
  size: number
  width?: number
  height?: number
  orientation?: number
  dateTaken?: number
  dateModified?: number
  dateAdded?: number
  isFavorite: boolean
  isMotionPhoto: boolean
  durationMs?: number
  thumbState: ThumbState
  /** 手机上已经删除了，但电脑仍保留着这份备份 */
  sourceDeleted: boolean
  /** 被用户移入回收站的时间（毫秒）；不在回收站时为 undefined */
  deletedAt?: number
  /** 回收站到期时间（deletedAt + 保留天数）：到点自动彻底删除 */
  purgeAt?: number
}

export interface AlbumRecord {
  bucketId: string
  bucketName: string
  relativePath: string
  deviceId: string
  count: number
  coverMediaId?: number
  latestDate: number
}

export interface DeviceRecord {
  id: string
  name: string
  model?: string
  mediaCount: number
  lastSyncAt?: number
  createdAt: number
  /** 若为副设备，指向主设备 ID；主设备为 undefined */
  mergedInto?: string
}

/** 手机端上报的单个媒体（协议 v1） */
export interface MediaItem {
  sha256: string
  displayName: string
  relativePath: string
  bucketId: string
  bucketName: string
  mimeType: string
  size: number
  width?: number
  height?: number
  orientation?: number
  dateTaken?: number
  dateModified?: number
  dateAdded?: number
  isFavorite?: boolean
  isMotionPhoto?: boolean
  durationMs?: number
}

export interface AlbumItem {
  bucketId: string
  bucketName: string
  relativePath: string
  count?: number
}

export interface DeviceInfo {
  deviceId: string
  name: string
  model?: string
  androidVersion?: string
}

export interface ManifestRequest {
  protocolVersion: number
  device: DeviceInfo
  albums?: AlbumItem[]
  items: MediaItem[]
}

export interface ManifestResponse {
  needed: string[]
  known: number
  total: number
  /** 该设备"手机上已删除但电脑保留"的数量 */
  missing?: number
  /** 本次状态发生变化的数量（新标记删除 + 恢复） */
  changed?: number
}

export interface CommitRequest {
  protocolVersion: number
  device: DeviceInfo
  albums?: AlbumItem[]
  items: MediaItem[]
}

export interface CommitResponse {
  inserted: number
  skipped: number
  total: number
}

export interface UploadStatus {
  exists: boolean
  received: number
  size: number
}

export interface HubHealth {
  name: string
  version: string
  protocolVersion: number
  uptimeMs: number
  time: string
}

export interface StorageCounts {
  devices: number
  albums: number
  media: number
  blobs: number
  /** 回收站里的条目数 */
  trash: number
}

/** GET /api/v1/trash —— 回收站列表 */
export interface TrashResponse {
  media: MediaRecord[]
  /** 保留天数（界面显示"剩 N 天"用；服务端是唯一权威） */
  retentionDays: number
}

/** 移入回收站 / 恢复 / 彻底删除的统一返回 */
export interface TrashActionResult {
  ok: boolean
  /** 本次影响的条目数 */
  count: number
  /** 彻底删除时释放的字节数（其余情况为 undefined） */
  freedBytes?: number
}

/** 拖出到资源管理器前的准备结果（真实磁盘路径，带扩展名） */
export interface DragPrepareResult {
  files: { path: string; name: string; size: number }[]
}

export interface HubStatus {
  running: boolean
  host: string
  port: number
  addresses: string[]
  /** 本地设置页显示的一次性配对码；不通过 Hub HTTP 接口返回。 */
  pairingCode?: string
  pairingExpiresAt?: number
  error?: string
}

export interface AppStatus {
  appName: string
  appVersion: string
  protocolVersion: number
  /** 只通过本地 IPC 给桌面端设置页使用，不由 Hub HTTP 接口返回 */
  hubToken: string
  /** 自签名 Hub 证书 SHA-256 指纹，只通过本地 IPC 显示给用户核对 */
  hubCertFingerprint: string
  dataDir: string
  dbPath: string
  runtimeDir: string
  /** 自定义贴图目录（放图片进去，界面自动使用） */
  stickersDir: string
  /** 高清背景图的版本（文件修改时间），用于避免浏览器缓存旧图 */
  backgroundVersion: number
  counts: StorageCounts
  hub: HubStatus
}

export interface ChooseDataDirResult {
  dataDir: string
  changed: boolean
}

export interface MergeResult {
  sourceDeviceId: string
  targetDeviceId: string
  /** 合并后该组（主设备 + 副设备）的媒体总数 */
  mediaCount: number
}

export interface SplitResult {
  deviceId: string
  /** 本次恢复独立的设备数量 */
  detached: number
}

/** 用户在电脑端"导入/导出"时的任务进度 */
export interface TaskProgress {
  taskId: string
  type: 'import' | 'export'
  phase: 'scanning' | 'working' | 'done' | 'error'
  rootPath: string
  total: number
  processed: number
  imported: number
  skipped: number
  failed: number
  /** 本次导入中"曾经被删除过、现在重新加回来"的数量（手动导入会清掉删除墓碑） */
  restored: number
  current: string
  error?: string
  startedAt: number
  finishedAt?: number
}

/** preload 暴露给渲染进程的 API */
export interface GmApi {
  getStatus(): Promise<AppStatus>
  refreshPairingCode(): Promise<AppStatus>
  openDataDir(): Promise<string>
  openStickersDir(): Promise<string>
  chooseDataDir(): Promise<ChooseDataDirResult>
  restartApp(): Promise<void>
  pickFolder(title?: string): Promise<string | null>
  /** 导入文件夹；指定 deviceId 时导入到已有设备（可作为主/副设备），否则按文件夹新建 */
  importFolder(dir: string, deviceId?: string): Promise<TaskProgress>
  exportTo(targetDir: string, query: ExportQuery): Promise<TaskProgress>
  mergeDevices(sourceDeviceId: string, targetDeviceId: string): Promise<MergeResult>
  splitDevice(deviceId: string): Promise<SplitResult>
  /**
   * 把媒体准备成"资源管理器认识的真实文件"（在仓库 tmp 目录里做硬链接，瞬间完成、不占额外空间）。
   * 返回的文件名带原始扩展名，供拖出到桌面/文件夹用。
   */
  prepareDrag(mediaIds: number[]): Promise<DragPrepareResult>
  /**
   * 开始一次原生「拖出到资源管理器」（只复制、不移动）。
   * 必须在渲染端的 dragstart 里同步调用（且要先 preventDefault，否则渲染进程会卡死）。
   */
  startDrag(mediaIds: number[]): void
  /**
   * 视频首帧缩略图：渲染端用 `<video>` 抽一帧、canvas 编成 webp 后交给主进程落盘。
   * ⚠️ 主进程**绝不解码视频**（那是 2026-09-24 闪退的根因），它只收"已经编好的 webp 字节"。
   */
  saveVideoThumb(mediaId: number, bytes: ArrayBuffer): Promise<boolean>
  /** 视频抽帧失败（Chromium 解不了这个编码）：记成 failed，别反复重试 */
  markVideoThumbFailed(mediaId: number): Promise<void>
  onProgress(callback: (progress: TaskProgress) => void): () => void
  onSyncProgress(callback: (progress: SyncProgress) => void): () => void
  onPairingRequested(callback: () => void): () => void
  onPairing(callback: () => void): () => void
  onDataChanged(callback: () => void): () => void
}

export interface ExportQuery {
  deviceId?: string
  bucketId?: string
}

/** 手机端同步的阶段 */
export type SyncPhase = 'preparing' | 'uploading' | 'done'

/** 手机正在往电脑上传时的实时进度（电脑端显示进度条用） */
export interface SyncProgress {
  deviceId: string
  deviceName: string
  /**
   * 当前阶段。
   * `preparing` = 手机在扫描相册/计算文件指纹（可能几分钟，期间一个字节都还没传）
   * 老客户端不发准备通知，此时可能是 undefined，按 `uploading` 处理
   */
  phase?: SyncPhase
  /** 本次需要上传的文件数 */
  needed: number
  /** 已经收到并校验通过的文件数 */
  received: number
  /** 已接收的字节数（已完成文件） */
  bytes: number
  /** 正在传输的这个文件已接收的字节数 */
  currentBytes: number
  /** 本次需要上传的字节总数 */
  neededBytes: number
  /** 准备阶段：手机本次要处理的文件总数 */
  prepareTotal?: number
  /** 准备阶段：本次要读取的字节总数 */
  prepareTotalBytes?: number
  /** 准备阶段：手机已算完指纹的文件数 */
  hashed?: number
  /** 准备阶段：手机已读取的字节数 */
  hashedBytes?: number
  /** 是否已提交完成 */
  done: boolean
  startedAt: number
}

/** 手机开始扫描/算指纹前先打个招呼，免得电脑端一直看起来「没反应」 */
export interface SyncPrepareRequest {
  protocolVersion: number
  device: DeviceInfo
  /** 本次要处理的文件总数 */
  total?: number
  /** 本次要读取的字节总数 */
  totalBytes?: number
  /** 已算完指纹的文件数（首次上报时是 0） */
  hashed?: number
  /** 已读取的字节数 */
  hashedBytes?: number
}
