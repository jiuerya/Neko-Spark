import { createReadStream, existsSync } from 'node:fs'
import { createSocket, type Socket as UdpSocket } from 'node:dgram'
import { execFileSync } from 'node:child_process'
import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises'
import { createServer, type Server } from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { networkInterfaces } from 'node:os'
import { dirname, join } from 'node:path'
import { createHash, randomInt } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import {
  APP_NAME,
  PROTOCOL_VERSION,
  TRASH_RETENTION_DAYS,
  type AlbumRecord,
  type CommitRequest,
  type DeviceInfo,
  type DeviceRecord,
  type HubStatus,
  type ManifestRequest,
  type ManifestResponse,
  type MediaItem,
  type MediaRecord,
  type SyncPrepareRequest,
  type SyncProgress,
  type TaskProgress,
  type TrashActionResult,
  type TrashResponse,
  type UploadStatus
} from '@shared/types'
import type { Database, NewMediaInput } from './db'
import type { StoragePaths } from './storage'
import { blobPath, isStickerFile, stickerContentType, thumbPath, videoThumbPath } from './storage'
import { hashFile } from './importer'
import { detectKind, guessMime } from './media'
import { ensurePreview, ensureThumbnail, processPendingThumbs } from './thumbs'
import { purgeTrash, restoreMedia, sweepExpiredTrash, trashMedia } from './trash'
import { HUB_TOKEN_HEADER, isLoopbackAddress, tokenMatches } from './auth'
import type { HubTlsCredentials } from './tls'
import { startMdns } from './mdns'
import { log, logError } from '../logger'

const DEFAULT_PORT = 8787
const PORT_CANDIDATE_COUNT = 3
const MAX_JSON_BODY = 64 * 1024 * 1024
const MAX_TEXT_FIELD = 4096
const MAX_DEVICE_ID = 256
const MAX_ID_LIST = 5000
const PAIRING_CODE_TTL_MS = 10 * 60 * 1000
const PAIRING_CODE_MAX_ATTEMPTS = 8
/** 局域网发现：手机广播这个口令，电脑回自己的地址信息 */
export const DISCOVERY_PORT = 8788
export const DISCOVERY_REQUEST = 'GALLERY_MIRROR_DISCOVER'

export interface HubOptions {
  db: Database
  paths: StoragePaths
  version: string
  authToken: string
  tls: HubTlsCredentials
  port?: number
  onDataChanged?: () => void
  onTaskProgress?: (progress: TaskProgress) => void
  onTaskDone?: (progress: TaskProgress) => void
  /** 手机上传进度（电脑端显示进度条） */
  onSyncProgress?: (progress: SyncProgress) => void
  /** 手机通过一次性配对码完成首次配对；只通知本地 renderer，不携带 token。 */
  onPairing?: () => void
  /** 手机通过局域网发现开始寻找主机；通知本地 renderer 显示待输入配对码。 */
  onPairingRequested?: () => void
}

export interface HubHandle {
  status: HubStatus
  refreshPairingCode(): void
  stop(): Promise<void>
}

interface PairingState {
  code: string
  expiresAt: number
  attempts: number
  used: boolean
}

function newPairingState(): PairingState {
  return {
    code: randomInt(0, 1_000_000).toString().padStart(6, '0'),
    expiresAt: Date.now() + PAIRING_CODE_TTL_MS,
    attempts: 0,
    used: false
  }
}

function identifierFingerprint(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0
    ? createHash('sha256').update(value).digest('hex').slice(0, 12)
    : undefined
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store'
  })
  res.end(payload)
}

function lanAddresses(port: number): string[] {
  const VIRTUAL_ADAPTER_HINT =
    /(vethernet|hyper-v|vmware|virtualbox|tap|tun|clash|wsl|docker|zerotier|tailscale|npcap|loopback)/i
  const score = (adapterName: string, address: string): number => {
    let value = 0
    if (/^192\.168\./.test(address)) value += 40
    else if (/^10\./.test(address)) value += 35
    else if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) value += 30
    else if (/^169\.254\./.test(address)) value -= 60
    else if (/^198\.(18|19)\./.test(address)) value -= 50
    else value += 10
    if (VIRTUAL_ADAPTER_HINT.test(adapterName)) value -= 25
    return value
  }

  const candidates: { address: string; score: number }[] = []
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family === 'IPv4' && !net.internal) {
        candidates.push({ address: net.address, score: score(name, net.address) })
      }
    }
  }
  const real = candidates.filter((item) => item.score > 0)
  const usable = real.length > 0 ? real : candidates
  return usable.sort((a, b) => b.score - a.score).map((item) => `https://${item.address}:${port}`)
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      server.removeListener('listening', onListening)
      reject(err)
    }
    const onListening = (): void => {
      server.removeListener('error', onError)
      const address = server.address()
      resolve(typeof address === 'object' && address ? address.port : port)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, '0.0.0.0')
  })
}

async function listenWithFallback(server: Server, preferred: number): Promise<number> {
  const candidates = Array.from({ length: PORT_CANDIDATE_COUNT }, (_, index) => preferred + index)
  for (const port of candidates) {
    // Windows 允许 0.0.0.0 与某个具体网卡地址同时监听同一端口，
    // 这会让手机访问局域网地址时命中别的进程。启动前先检查 LISTENING，避免二维码广播一个实际上不可达的端口。
    if (process.platform === 'win32' && hasTcpListener(port)) {
      log('warn', 'hub.port_occupied', { port })
      continue
    }
    try {
      return await listen(server, port)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err
      log('warn', 'hub.port_bind_conflict', { port })
    }
  }
  throw new Error(`端口 ${candidates.join('、')} 全部被占用`)
}

function hasTcpListener(port: number): boolean {
  try {
    const output = execFileSync('netstat.exe', ['-ano', '-p', 'tcp'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 1000
    })
    return output.split(/\r?\n/).some((line) => {
      const columns = line.trim().split(/\s+/)
      if (columns.length < 4 || columns[0].toUpperCase() !== 'TCP') return false
      if (columns[3].toUpperCase() !== 'LISTENING') return false
      const localEndpoint = columns[1]
      return localEndpoint.endsWith(`:${port}`) || localEndpoint.endsWith(`]:${port}`)
    })
  } catch {
    // netstat 不可用时仍让内核尝试绑定；EADDRINUSE 仍会走下面的候选端口。
    return false
  }
}

function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let rejected = false
    const declared = Number(req.headers['content-length'] ?? '')
    if (Number.isSafeInteger(declared) && declared > MAX_JSON_BODY) {
      reject(new Error('request_too_large'))
      req.destroy()
      return
    }
    req.on('data', (chunk: Buffer) => {
      if (rejected) return
      size += chunk.length
      if (size > MAX_JSON_BODY) {
        rejected = true
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('error', reject)
    req.on('end', () => {
      if (rejected) return
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')) as T)
      } catch {
        reject(new Error('invalid_json'))
      }
    })
  })
}

function isSafeText(value: unknown, max = MAX_TEXT_FIELD, allowEmpty = true): value is string {
  return (
    typeof value === 'string' &&
    value.length <= max &&
    (allowEmpty || value.length > 0) &&
    !/[\u0000-\u001f\u007f]/.test(value)
  )
}

function isSafeRelativePath(value: unknown): value is string {
  if (!isSafeText(value)) return false
  if (value.length === 0) return true
  if (value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false
  const parts = value.split('/')
  // MediaStore 的 RELATIVE_PATH 和协议中的相册目录通常以一个 `/` 结尾；
  // 只去掉这个目录标记，仍拒绝中间空段、绝对路径和 `.`/`..`。
  if (parts.at(-1) === '') parts.pop()
  return parts.length > 0 && parts.every((part) => part.length > 0 && part !== '.' && part !== '..')
}

function isSafeFileName(value: unknown): value is string {
  return (
    isSafeText(value, 255, false) &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('/') &&
    !value.includes('\\')
  )
}

function isValidDevice(device: unknown): boolean {
  if (!device || typeof device !== 'object') return false
  const value = device as { deviceId?: unknown; name?: unknown; model?: unknown; androidVersion?: unknown }
  return (
    isSafeText(value.deviceId, MAX_DEVICE_ID, false) &&
    isSafeText(value.name, 255, false) &&
    (value.model === undefined || isSafeText(value.model, 255)) &&
    (value.androidVersion === undefined || isSafeText(value.androidVersion, 64))
  )
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isValidOptionalMediaFields(item: MediaItem): boolean {
  const safeNonNegativeInt = (value: unknown): boolean => value === undefined || isSafeNonNegativeInteger(value)
  return (
    safeNonNegativeInt(item.width) &&
    safeNonNegativeInt(item.height) &&
    safeNonNegativeInt(item.orientation) &&
    safeNonNegativeInt(item.dateTaken) &&
    safeNonNegativeInt(item.dateModified) &&
    safeNonNegativeInt(item.dateAdded) &&
    safeNonNegativeInt(item.durationMs) &&
    (item.isFavorite === undefined || typeof item.isFavorite === 'boolean') &&
    (item.isMotionPhoto === undefined || typeof item.isMotionPhoto === 'boolean') &&
    (item.size === undefined || isSafeNonNegativeInteger(item.size)) &&
    (item.bucketId === undefined || isSafeText(item.bucketId)) &&
    (item.bucketName === undefined || isSafeText(item.bucketName, 255)) &&
    (item.mimeType === undefined || isSafeText(item.mimeType, 255))
  )
}

function isValidMediaItem(item: unknown): item is MediaItem {
  if (!item || typeof item !== 'object') return false
  const value = item as MediaItem
  return (
    /^[0-9a-f]{64}$/.test(value.sha256) &&
    isSafeFileName(value.displayName) &&
    isSafeRelativePath(value.relativePath) &&
    Number.isSafeInteger(value.size) &&
    value.size >= 0 &&
    isValidOptionalMediaFields(value)
  )
}

function isSafeMediaIdentity(item: unknown): item is MediaItem {
  if (!item || typeof item !== 'object') return false
  const value = item as MediaItem
  return (
    /^[0-9a-f]{64}$/.test(value.sha256) &&
    isSafeFileName(value.displayName) &&
    isSafeRelativePath(value.relativePath) &&
    isValidOptionalMediaFields(value)
  )
}

function parseIds(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ID_LIST) return null
  if (value.some((id) => !Number.isSafeInteger(id) || Number(id) <= 0)) return null
  return [...new Set(value as number[])]
}

function hasSupportedProtocol(body: unknown): boolean {
  return !!body && typeof body === 'object' && (body as { protocolVersion?: unknown }).protocolVersion === PROTOCOL_VERSION
}

function sendUnsupportedProtocol(res: ServerResponse): void {
  sendJson(res, 426, { error: 'unsupported_protocol', protocolVersion: PROTOCOL_VERSION })
}

function parseByteRange(value: string, size: number): { start: number; end: number } | null {
  if (size <= 0) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim())
  if (!match || (!match[1] && !match[2])) return null

  let start: number
  let end: number
  if (!match[1]) {
    const suffixLength = Number(match[2])
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null
    start = Math.max(0, size - suffixLength)
    end = size - 1
  } else {
    start = Number(match[1])
    if (!Number.isSafeInteger(start) || start < 0 || start >= size) return null
    end = match[2] ? Number(match[2]) : size - 1
    if (!Number.isSafeInteger(end) || end < start) return null
    end = Math.min(end, size - 1)
  }
  return { start, end }
}

function isTrustedOrigin(origin: string): boolean {
  if (origin === 'null' || origin === 'file://') return true
  try {
    const parsed = new URL(origin)
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      ['localhost', '127.0.0.1', '[::1]', '::1'].includes(parsed.hostname)
    )
  } catch {
    return false
  }
}

/**
 * 清单条目是否带齐了"入库必需"的字段。
 * 清单的核心用途是比对，历史客户端/测试可能只发 sha256+文件名（不带 size 等），
 * 这种情况不能让它 500 —— 跳过流式入库，交给 commit 兜底即可。
 */
function canIngestItem(item: MediaItem): boolean {
  return isValidMediaItem(item)
}

function mediaItemToInput(deviceId: string, item: MediaItem, actualBlobSize = item.size): NewMediaInput {
  const ext = item.displayName.includes('.') ? item.displayName.slice(item.displayName.lastIndexOf('.')) : ''
  const kind = detectKind(`x${ext}`) ?? (item.mimeType?.startsWith('video') ? 'video' : 'image')
  const relativePath = item.relativePath || ''
  return {
    deviceId,
    blobSha256: item.sha256,
    displayName: item.displayName,
    relativePath,
    bucketId: item.bucketId || relativePath || '/',
    bucketName: item.bucketName || (relativePath ? relativePath.replace(/\/$/, '').split('/').pop() ?? '' : ''),
    kind,
    mime: item.mimeType || guessMime(item.displayName),
    // 原始 blob 的实际大小优先，避免客户端元数据写错后污染恢复时的去重判断。
    size: actualBlobSize,
    width: item.width,
    height: item.height,
    orientation: item.orientation,
    dateTaken: item.dateTaken,
    dateModified: item.dateModified,
    dateAdded: item.dateAdded,
    isFavorite: item.isFavorite,
    isMotion: item.isMotionPhoto,
    durationMs: item.durationMs,
    thumbState: kind === 'image' ? 'pending' : 'none'
  }
}

/** 启动局域网发现应答（手机端"搜索电脑"用的） */
function startDiscovery(version: string, getPort: () => number, fingerprint: string, onRequest?: () => void): () => void {
  let socket: UdpSocket | null = null
  try {
    socket = createSocket({ type: 'udp4', reuseAddr: true })
    socket.on('error', () => {
      try {
        socket?.close()
      } catch {
        /* 忽略 */
      }
      socket = null
    })
    socket.on('message', (message, remote) => {
      if (message.toString().trim() !== DISCOVERY_REQUEST) return
      onRequest?.()
      const payload = JSON.stringify({
        name: APP_NAME,
        version,
        port: getPort(),
        protocol: 'https',
        fingerprint,
        protocolVersion: PROTOCOL_VERSION
      })
      try {
        socket?.send(payload, remote.port, remote.address)
      } catch {
        /* 忽略单次发送失败 */
      }
    })
    socket.bind(DISCOVERY_PORT, () => {
      try {
        socket?.setBroadcast(true)
      } catch {
        /* 某些环境不支持，忽略 */
      }
    })
  } catch {
    socket = null
  }
  return () => {
    try {
      socket?.close()
    } catch {
      /* 忽略 */
    }
  }
}

/**
 * 清理过期的分片残留。
 * `.part` 是断点续传的凭据（手机下次接着传要用），所以不能见着就删；
 * 只有长时间没人来续的才算垃圾 —— 否则中断一次就会永久留下几十上百 MB。
 */
async function cleanupStaleParts(uploadsDir: string, maxAgeMs: number): Promise<number> {
  let removed = 0
  let entries
  try {
    entries = await readdir(uploadsDir, { withFileTypes: true })
  } catch {
    return 0 // 目录不存在：还没上传过，正常
  }
  const now = Date.now()
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.part')) continue
    const file = join(uploadsDir, entry.name)
    try {
      const info = await stat(file)
      if (now - info.mtimeMs > maxAgeMs) {
        await rm(file, { force: true })
        removed += 1
      }
    } catch {
      // 单个文件异常不影响其他
    }
  }
  return removed
}

export async function startHub(options: HubOptions): Promise<HubHandle> {
  const startedAt = Date.now()
  const { db, paths } = options
  let pairing = newPairingState()
  let lastPairSuccessAt = 0
  let lastPairingNoticeAt = 0
  const activeUploads = new Map<string, { received: number }>()

  // 本次清单的元数据暂存：blob 一落盘就立刻入库，照片边传边出现（不用等整轮同步结束）
  // 一个 blob 可能对应手机清单里的多条媒体记录（重复文件内容）；全部保留，
  // 否则第一条传完时只会实时显示一张，剩余条目要等整轮 commit 才出现。
  const pendingMeta = new Map<string, { deviceId: string; item: MediaItem }[]>()

  // 手机本次同步会话（用于电脑端进度条）
  let sync: SyncProgress | null = null
  const emitSync = (): void => {
    if (sync) options.onSyncProgress?.({ ...sync })
  }

  // 「准备中」阶段没有后续（手机被杀/断网）时的兜底：撤掉进度条，免得电脑端一直挂着
  const PREPARE_TIMEOUT_MS = 3 * 60 * 1000
  let prepareTimer: ReturnType<typeof setTimeout> | null = null
  const clearPrepareTimer = (): void => {
    if (prepareTimer) {
      clearTimeout(prepareTimer)
      prepareTimer = null
    }
  }
  const armPrepareTimer = (): void => {
    clearPrepareTimer()
    prepareTimer = setTimeout(() => {
      prepareTimer = null
      if (sync && sync.phase === 'preparing' && !sync.done) {
        sync.done = true
        sync.phase = 'done'
        emitSync()
      }
    }, PREPARE_TIMEOUT_MS)
  }

  const notifyChanged = (): void => {
    options.onDataChanged?.()
  }

  const runThumbBackfill = (): void => {
    void processPendingThumbs(db, paths.blobsDir, paths.thumbsDir).then((count) => {
      if (count > 0) notifyChanged()
    })
  }

  const THUMB_BACKFILL_EVERY_MS = 3000
  const THUMB_BACKFILL_BATCH = 120
  let thumbBackfillTimer: ReturnType<typeof setTimeout> | null = null
  const scheduleThumbBackfill = (): void => {
    if (thumbBackfillTimer) return
    thumbBackfillTimer = setTimeout(() => {
      thumbBackfillTimer = null
      void processPendingThumbs(db, paths.blobsDir, paths.thumbsDir, undefined, THUMB_BACKFILL_BATCH)
    }, THUMB_BACKFILL_EVERY_MS)
  }
  const clearThumbBackfillTimer = (): void => {
    if (thumbBackfillTimer) {
      clearTimeout(thumbBackfillTimer)
      thumbBackfillTimer = null
    }
  }

  const server = createServer({ key: options.tls.key, cert: options.tls.cert }, (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const segments = url.pathname.split('/').filter(Boolean)
    const method = req.method ?? 'GET'
    const origin = req.headers.origin

    if (origin && !isTrustedOrigin(origin)) {
      sendJson(res, 403, { error: 'origin_not_allowed' })
      return
    }

    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
    }
    res.setHeader('X-Content-Type-Options', 'nosniff')
    // ⚠️ 必须带上 Range：渲染端读视频 moov 盒子算帧率时会带 Range 头去 fetch，
    //    不带 Range 的话预检失败，浏览器直接拦掉请求（帧率就永远取不到）
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Content-Range, Range, X-Gallery-Mirror-Token')
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS, HEAD')
    if (method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    // 配对是唯一允许在没有访问密钥时调用的接口。它只接受短时一次性口令，
    // 成功后才返回 Hub token；二维码、mDNS 和普通错误响应都不会暴露 token。
    const isPairingRequest = method === 'POST' && url.pathname === '/api/v1/pair'
    if (!isPairingRequest && !isLoopbackAddress(req.socket.remoteAddress) && !tokenMatches(options.authToken, String(req.headers[HUB_TOKEN_HEADER] ?? ''))) {
      res.setHeader('WWW-Authenticate', 'GalleryMirror token')
      sendJson(res, 401, { error: 'unauthorized' })
      return
    }

    void handleRoute().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      logError('hub.request_failed', err, { method, path: url.pathname })
      console.error('[hub] 请求失败:', message)
      if (!res.headersSent) {
        const status = message === 'request_too_large' || message === '请求体过大' ? 413 : message === 'invalid_json' ? 400 : 500
        sendJson(res, status, {
          error: status === 400 ? 'invalid_json' : status === 413 ? 'request_too_large' : 'internal_error'
        })
      }
      else res.end()
    })

    async function handleRoute(): Promise<void> {
      // POST /api/v1/pair —— 手机首次配对，配对码只允许成功一次
      if (isPairingRequest) {
        log('info', 'hub.pair_request_received', {
          attempts: pairing.attempts,
          hasOrigin: Boolean(origin),
          remoteAddressPresent: Boolean(req.socket.remoteAddress)
        })
        if (pairing.used || pairing.expiresAt <= Date.now()) {
          log('info', 'hub.pair_result', { status: 410, reason: 'expired' })
          sendJson(res, 410, { error: 'pairing_code_expired' })
          return
        }
        if (pairing.attempts >= PAIRING_CODE_MAX_ATTEMPTS) {
          log('info', 'hub.pair_result', { status: 429, reason: 'locked' })
          sendJson(res, 429, { error: 'pairing_code_locked' })
          return
        }
        const body = await readJsonBody<{ code?: unknown; device?: unknown }>(req)
        if (!hasSupportedProtocol(body)) {
          log('info', 'hub.pair_result', { status: 426, reason: 'unsupported_protocol' })
          sendUnsupportedProtocol(res)
          return
        }
        // 新版手机会在配对时带上设备身份；旧版只发送 code，仍按兼容路径放行，
        // 后续 manifest/commit 会补登记。带了设备字段却不合法时不能静默丢弃，
        // 否则手机会显示“配对成功”，电脑端却永远没有对应设备。
        if (body?.device !== undefined && !isValidDevice(body.device)) {
          log('info', 'hub.pair_result', { status: 400, reason: 'invalid_device' })
          sendJson(res, 400, { error: 'invalid_device' })
          return
        }
        const code = typeof body?.code === 'string' ? body.code.trim() : ''
        pairing.attempts += 1
        if (!/^\d{6}$/.test(code) || code !== pairing.code) {
          log('info', 'hub.pair_result', {
            status: 401,
            reason: 'invalid_pairing_code',
            codeFormatValid: /^\d{6}$/.test(code),
            deviceIdHash: identifierFingerprint((body?.device as { deviceId?: unknown } | undefined)?.deviceId)
          })
          sendJson(res, 401, { error: 'invalid_pairing_code' })
          return
        }
        pairing.used = true
        // 立刻轮换设置页上的码，避免截图/旧二维码继续可用。
        const next = newPairingState()
        pairing = next
        status.pairingCode = next.code
        status.pairingExpiresAt = next.expiresAt
        const device = body?.device as DeviceInfo | undefined
        if (device) {
          // 配对成功就先建立一条没有媒体的设备记录，让设备页立即能看到这台手机；
          // 最近同步时间仍等首次 manifest/commit 后再写，避免把“已配对”误报成“已备份”。
          db.upsertDevice({
            id: device.deviceId,
            name: device.name || device.deviceId,
            model: device.model,
            androidId: device.androidVersion
          })
        }
        options.onDataChanged?.()
        lastPairSuccessAt = Date.now()
        options.onPairing?.()
        log('info', 'hub.pair_result', {
          status: 200,
          reason: 'success',
          deviceRegistered: Boolean(device),
          deviceIdHash: identifierFingerprint(device?.deviceId)
        })
        sendJson(res, 200, { ok: true, token: options.authToken, deviceRegistered: Boolean(device) })
        return
      }

      // GET /api/v1/health
      if (method === 'GET' && url.pathname === '/api/v1/health') {
        sendJson(res, 200, {
          name: APP_NAME,
          version: options.version,
          protocolVersion: PROTOCOL_VERSION,
          uptimeMs: Date.now() - startedAt,
          time: new Date().toISOString()
        })
        return
      }

      // GET /api/v1/info
      if (method === 'GET' && url.pathname === '/api/v1/info') {
        sendJson(res, 200, {
          counts: db.counts(),
          sourceDeleted: db.countSourceDeleted()
        })
        return
      }

      // GET /api/v1/devices
      if (method === 'GET' && url.pathname === '/api/v1/devices') {
        const devices: DeviceRecord[] = db.listDevices()
        sendJson(res, 200, { devices })
        return
      }

      // GET /api/v1/albums
      if (method === 'GET' && url.pathname === '/api/v1/albums') {
        const deviceId = url.searchParams.get('deviceId') ?? undefined
        const albums: AlbumRecord[] = db.listAlbums(deviceId)
        sendJson(res, 200, { albums })
        return
      }

      // GET /api/v1/media
      if (method === 'GET' && url.pathname === '/api/v1/media') {
        const devices = url.searchParams.get('deviceId') ?? undefined
        const bucketId = url.searchParams.get('bucketId') ?? undefined
        const kindParam = url.searchParams.get('kind')
        const favorites = url.searchParams.get('favorites') === '1'
        const media: MediaRecord[] = db.listMedia({
          deviceId: devices,
          bucketId,
          kind: kindParam === 'video' || kindParam === 'image' ? kindParam : undefined,
          favoritesOnly: favorites
        })
        sendJson(res, 200, { media })
        return
      }

      // GET /api/v1/thumb/:id
      if (method === 'GET' && segments[0] === 'api' && segments[1] === 'v1' && segments[2] === 'thumb' && segments[3]) {
        const id = Number(segments[3])
        if (!Number.isSafeInteger(id) || id <= 0) {
          sendJson(res, 400, { error: 'invalid_media_id' })
          return
        }
        // 回收站里的也要能出缩略图（用户得看得见自己删了什么才好挑着恢复）
        const media = db.getMediaAny(id)
        if (!media) {
          sendJson(res, 404, { error: 'not_found' })
          return
        }
        // ⚠️ 只有图片才谈得上"现场生成缩略图"。视频（甚至 900MB 的）一旦被送进 sharp 解码，
        // libvips 会原生崩溃、把整个应用带走 —— 实测 2026-09-24 的闪退就是这个。
        //
        // 视频的首帧由**渲染端的 Chromium 抽**（`utils/videoThumb.ts`）编成 webp 存进缩略图目录，
        // 这里只负责把它吐出去：所以判据是"已经生成好了（thumbState === 'ready'）"，
        // 只要不是 ready 就 404 —— 下面那行 `ensureThumbnail` 永远不会碰到视频。
        if (media.kind !== 'image' && media.thumbState !== 'ready') {
          sendJson(res, 404, { error: 'thumb_unavailable' })
          return
        }
        // 图片缩略图现在是 **JPEG**（同尺寸同观感，但 Chromium 解 JPEG 比解 WebP 快 3.2 倍），
        // 视频首帧仍是 **webp**（那些字节是渲染端用 canvas 编的）。
        // 迁移期老库里还留着 webp 的图片缩略图 —— 按"哪个文件在"决定类型，两个都认。
        let file = thumbPath(paths.thumbsDir, media.blobSha256)
        let contentType = 'image/jpeg'
        if (media.thumbState !== 'ready') {
          const generated = await ensureThumbnail(db, paths.blobsDir, paths.thumbsDir, media.id, media.blobSha256)
          if (!generated) {
            sendJson(res, 404, { error: 'thumb_unavailable' })
            return
          }
          file = generated
        }
        if (!existsSync(file)) {
          const legacy = videoThumbPath(paths.thumbsDir, media.blobSha256)
          if (existsSync(legacy)) {
            file = legacy
            contentType = 'image/webp'
          }
        }
        try {
          const info = await stat(file)
          res.writeHead(200, {
            'Content-Type': contentType,
            'Content-Length': info.size,
            'Cache-Control': 'public, max-age=31536000, immutable'
          })
          createReadStream(file).pipe(res)
        } catch {
          sendJson(res, 404, { error: 'thumb_missing' })
        }
        return
      }

      // GET /api/v1/preview/:id —— 查看器用的大预览图（webp，最长边 2560）
      //
      // 为什么单独开一个接口：**Chromium 解不了 DNG / HEIC / HEIF / TIFF**，
      // 查看器直接拿 `/file/:id` 的原始字节会静默失败（界面表现："点开什么都没有"）。
      //
      // ⚠️ 绝不能在 `/file/:id` 上做这件事：手机恢复（回写相册）走的就是它，
      // 协议承诺"不转码、不压缩、不改名"——必须是原始字节。所以预览另起一条路。
      if (method === 'GET' && segments[0] === 'api' && segments[1] === 'v1' && segments[2] === 'preview' && segments[3]) {
        const id = Number(segments[3])
        if (!Number.isSafeInteger(id) || id <= 0) {
          sendJson(res, 400, { error: 'invalid_media_id' })
          return
        }
        const media = db.getMediaAny(id)
        // 只有图片谈得上"生成预览"（视频由 Chromium 自己播，走 /file 的 Range）
        if (!media || media.kind !== 'image') {
          sendJson(res, 404, { error: 'preview_unavailable' })
          return
        }
        const file = await ensurePreview(paths.thumbsDir, paths.blobsDir, media.blobSha256)
        if (!file) {
          sendJson(res, 404, { error: 'preview_unavailable' })
          return
        }
        try {
          const info = await stat(file)
          res.writeHead(200, {
            'Content-Type': 'image/webp',
            'Content-Length': info.size,
            'Cache-Control': 'public, max-age=31536000, immutable'
          })
          createReadStream(file).pipe(res)
        } catch {
          sendJson(res, 404, { error: 'preview_missing' })
        }
        return
      }

      // GET /api/v1/file/:id （支持 Range，供视频播放）
      if (method === 'GET' && segments[0] === 'api' && segments[1] === 'v1' && segments[2] === 'file' && segments[3]) {
        const id = Number(segments[3])
        if (!Number.isSafeInteger(id) || id <= 0) {
          sendJson(res, 400, { error: 'invalid_media_id' })
          return
        }
        const media = db.getMediaAny(id)
        if (!media) {
          sendJson(res, 404, { error: 'not_found' })
          return
        }
        const file = blobPath(paths.blobsDir, media.blobSha256)
        let info
        try {
          info = await stat(file)
        } catch {
          sendJson(res, 404, { error: 'blob_missing' })
          return
        }

        const range = req.headers.range
        const contentType = media.mime || 'application/octet-stream'
        if (range) {
          const parsedRange = parseByteRange(range, info.size)
          if (!parsedRange) {
            res.writeHead(416, { 'Content-Range': `bytes */${info.size}` })
            res.end()
            return
          }
          const { start, end } = parsedRange
          res.writeHead(206, {
            'Content-Type': contentType,
            'Content-Length': end - start + 1,
            'Content-Range': `bytes ${start}-${end}/${info.size}`,
            'Accept-Ranges': 'bytes'
          })
          createReadStream(file, { start, end }).pipe(res)
          return
        }

        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Length': info.size,
          'Accept-Ranges': 'bytes'
        })
        createReadStream(file).pipe(res)
        return
      }

      // GET /api/v1/background/:n —— 空状态用的高清背景图（可放 background-1..4.webp，可选）
      if (
        method === 'GET' &&
        segments[0] === 'api' &&
        segments[1] === 'v1' &&
        segments[2] === 'background'
      ) {
        const index = segments[3] ?? ''
        const candidates =
          index && /^\d$/.test(index)
            ? [join(paths.dataDir, `background-${index}.webp`), join(paths.dataDir, 'background.webp')]
            : [join(paths.dataDir, 'background.webp')]
        for (const file of candidates) {
          try {
            const info = await stat(file)
            res.writeHead(200, {
              'Content-Type': 'image/webp',
              'Content-Length': info.size,
              'Cache-Control': 'no-store'
            })
            createReadStream(file).pipe(res)
            return
          } catch {
            // 试下一个
          }
        }
        sendJson(res, 404, { error: 'no_background' })
        return
      }

      // GET /api/v1/stickers —— 列出用户自定义贴图
      if (method === 'GET' && url.pathname === '/api/v1/stickers') {
        let names: string[] = []
        try {
          const entries = await readdir(paths.stickersDir, { withFileTypes: true })
          names = entries
            .filter((entry) => entry.isFile() && isStickerFile(entry.name))
            .map((entry) => entry.name)
            .sort()
        } catch {
          names = []
        }
        sendJson(res, 200, { stickers: names })
        return
      }

      // GET /api/v1/sticker/:name —— 读取自定义贴图
      if (
        method === 'GET' &&
        segments[0] === 'api' &&
        segments[1] === 'v1' &&
        segments[2] === 'sticker' &&
        segments[3]
      ) {
        let name: string
        try {
          name = decodeURIComponent(segments[3])
        } catch {
          sendJson(res, 400, { error: 'invalid_name' })
          return
        }
        // 防目录穿越：只允许纯文件名
        if (name.includes('/') || name.includes('\\') || name.includes('..') || !isStickerFile(name)) {
          sendJson(res, 400, { error: 'invalid_name' })
          return
        }
        try {
          const file = join(paths.stickersDir, name)
          const info = await stat(file)
          res.writeHead(200, {
            'Content-Type': stickerContentType(name),
            'Content-Length': info.size,
            'Cache-Control': 'public, max-age=3600'
          })
          createReadStream(file).pipe(res)
        } catch {
          sendJson(res, 404, { error: 'sticker_missing' })
        }
        return
      }

      // POST /api/v1/device/merge —— 合并设备（可逆：source 作为副设备挂到 target 下）
      if (method === 'POST' && url.pathname === '/api/v1/device/merge') {
        const body = await readJsonBody<{ sourceDeviceId?: string; targetDeviceId?: string }>(req)
        const sourceId = typeof body?.sourceDeviceId === 'string' ? body.sourceDeviceId.trim() : ''
        const targetId = typeof body?.targetDeviceId === 'string' ? body.targetDeviceId.trim() : ''
        if (!isSafeText(sourceId, MAX_DEVICE_ID, false) || !isSafeText(targetId, MAX_DEVICE_ID, false)) {
          sendJson(res, 400, { error: 'missing_params' })
          return
        }
        if (!db.getDevice(sourceId) || !db.getDevice(targetId)) {
          sendJson(res, 404, { error: 'device_not_found' })
          return
        }
        try {
          const result = db.mergeDevices(sourceId, targetId)
          notifyChanged()
          sendJson(res, 200, { ok: true, ...result })
        } catch {
          sendJson(res, 400, { error: 'device_merge_failed' })
        }
        return
      }

      // POST /api/v1/device/split —— 分离设备（恢复独立）
      if (method === 'POST' && url.pathname === '/api/v1/device/split') {
        const body = await readJsonBody<{ deviceId?: string }>(req)
        const deviceId = typeof body?.deviceId === 'string' ? body.deviceId.trim() : ''
        if (!isSafeText(deviceId, MAX_DEVICE_ID, false)) {
          sendJson(res, 400, { error: 'missing_params' })
          return
        }
        if (!db.getDevice(deviceId)) {
          sendJson(res, 404, { error: 'device_not_found' })
          return
        }
        const result = db.splitDevice(deviceId)
        notifyChanged()
        sendJson(res, 200, { ok: true, ...result })
        return
      }

      // POST /api/v1/device/rename —— 手机端/电脑端都可以改设备名
      if (method === 'POST' && url.pathname === '/api/v1/device/rename') {
        const body = await readJsonBody<{ deviceId?: string; name?: string }>(req)
        const deviceId = typeof body?.deviceId === 'string' ? body.deviceId.trim() : ''
        const name = typeof body?.name === 'string' ? body.name.trim() : ''
        if (!isSafeText(deviceId, MAX_DEVICE_ID, false) || !isSafeText(name, 255, false)) {
          sendJson(res, 400, { error: 'missing_params' })
          return
        }
        if (!db.getDevice(deviceId)) {
          sendJson(res, 404, { error: 'device_not_found' })
          return
        }
        const ok = db.renameDevice(deviceId, name)
        if (ok) notifyChanged()
        sendJson(res, 200, { ok })
        return
      }

      // POST /api/v1/favorite
      if (method === 'POST' && url.pathname === '/api/v1/favorite') {
        const body = await readJsonBody<{ id?: number; favorite?: boolean }>(req)
        if (!Number.isSafeInteger(body?.id) || Number(body.id) <= 0 || typeof body.favorite !== 'boolean') {
          sendJson(res, 400, { error: 'missing_id' })
          return
        }
        if (!db.getMediaAny(Number(body.id))) {
          sendJson(res, 404, { error: 'media_not_found' })
          return
        }
        db.setFavorite(Number(body.id), !!body.favorite)
        notifyChanged()
        sendJson(res, 200, { ok: true })
        return
      }

      // GET /api/v1/trash —— 回收站列表（顺手做一次到期清理，界面打开时看到的必然是最新的）
      if (method === 'GET' && url.pathname === '/api/v1/trash') {
        const swept = await sweepExpiredTrash(db, paths)
        const deviceId = url.searchParams.get('deviceId') ?? undefined
        const media: MediaRecord[] = db.listTrash(deviceId)
        if (swept.count > 0) notifyChanged()
        const payload: TrashResponse = { media, retentionDays: TRASH_RETENTION_DAYS }
        sendJson(res, 200, payload)
        return
      }

      // POST /api/v1/media/trash —— 移入回收站（软删除，不删文件）
      if (method === 'POST' && url.pathname === '/api/v1/media/trash') {
        const body = await readJsonBody<{ ids?: number[] }>(req)
        const ids = parseIds(body?.ids)
        if (!ids || ids.length === 0) {
          sendJson(res, 400, { error: 'missing_ids' })
          return
        }
        const result: TrashActionResult = trashMedia(db, ids)
        if (result.count > 0) notifyChanged()
        sendJson(res, 200, result)
        return
      }

      // POST /api/v1/media/restore —— 从回收站恢复（放回原来的相册位置）
      if (method === 'POST' && url.pathname === '/api/v1/media/restore') {
        const body = await readJsonBody<{ ids?: number[] }>(req)
        const ids = parseIds(body?.ids)
        if (!ids || ids.length === 0) {
          sendJson(res, 400, { error: 'missing_ids' })
          return
        }
        const result: TrashActionResult = restoreMedia(db, ids)
        if (result.count > 0) notifyChanged()
        sendJson(res, 200, result)
        return
      }

      // POST /api/v1/media/purge —— 彻底删除（记录 + 磁盘文件）
      if (method === 'POST' && url.pathname === '/api/v1/media/purge') {
        const body = await readJsonBody<{ ids?: number[] }>(req)
        const ids = parseIds(body?.ids)
        if (!ids || ids.length === 0) {
          sendJson(res, 400, { error: 'missing_ids' })
          return
        }
        const result = await purgeTrash(db, paths, ids)
        if (result.count > 0) notifyChanged()
        sendJson(res, 200, result)
        return
      }

      // GET /api/v1/upload-status?sha256=
      if (method === 'GET' && url.pathname === '/api/v1/upload-status') {
        const sha = url.searchParams.get('sha256') ?? ''
        if (!/^[0-9a-f]{64}$/.test(sha)) {
          sendJson(res, 400, { error: 'invalid_sha256' })
          return
        }
        const exists = db.blobExists(sha)
        let received = activeUploads.get(sha)?.received ?? 0
        if (!exists) {
          try {
            const info = await stat(join(paths.uploadsDir, `${sha}.part`))
            received = info.size
          } catch {
            received = 0
          }
        }
        const payload: UploadStatus = { exists, received, size: exists ? db.blobSize(sha) ?? 0 : 0 }
        sendJson(res, 200, payload)
        return
      }

      // PUT /api/v1/blob/:sha256
      if (method === 'PUT' && segments[0] === 'api' && segments[1] === 'v1' && segments[2] === 'blob' && segments[3]) {
        const sha = segments[3].toLowerCase()
        if (!/^[0-9a-f]{64}$/.test(sha)) {
          sendJson(res, 400, { error: 'invalid_sha256' })
          return
        }
        if (db.blobExists(sha)) {
          req.resume()
          sendJson(res, 200, { received: 0, complete: true, existed: true })
          return
        }

        await mkdir(paths.uploadsDir, { recursive: true })
        const partPath = join(paths.uploadsDir, `${sha}.part`)

        const rangeHeader = req.headers['content-range']
        let offset = 0
        let total = 0
        let totalKnown = false
        let expectedChunkLength = 0
        const rawLength = req.headers['content-length']
        const contentLength = typeof rawLength === 'string' && /^\d+$/.test(rawLength) ? Number(rawLength) : undefined
        if (contentLength !== undefined && !Number.isSafeInteger(contentLength)) {
          sendJson(res, 413, { error: 'invalid_content_length' })
          return
        }
        if (typeof rangeHeader === 'string') {
          const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/.exec(rangeHeader.trim())
          if (!match) {
            sendJson(res, 400, { error: 'invalid_content_range' })
            return
          }
          const start = Number(match[1])
          const end = Number(match[2])
          offset = start
          total = Number(match[3])
          totalKnown = true
          expectedChunkLength = end - start + 1
          if (
            !Number.isSafeInteger(start) ||
            !Number.isSafeInteger(end) ||
            !Number.isSafeInteger(total) ||
            start < 0 ||
            end < start ||
            total <= end ||
            !Number.isSafeInteger(expectedChunkLength) ||
            (contentLength !== undefined && contentLength !== expectedChunkLength)
          ) {
            sendJson(res, 400, { error: 'invalid_content_range' })
            return
          }
        } else {
          offset = Number(url.searchParams.get('offset') ?? '0')
          total = Number(url.searchParams.get('total') ?? '0')
          if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(total) || offset < 0 || total < 0) {
            sendJson(res, 400, { error: 'invalid_upload_range' })
            return
          }
          if (contentLength !== undefined) {
            expectedChunkLength = contentLength
            if (total === 0) total = offset + contentLength
            totalKnown = true
          }
        }
        if (totalKnown && offset + expectedChunkLength > total) {
          sendJson(res, 400, { error: 'invalid_upload_range' })
          return
        }

        // 断点续传：如果本地没有分片文件，只能从 0 开始
        if (offset > 0 && !existsSync(partPath)) {
          offset = 0
          if (expectedChunkLength > 0 && totalKnown && total < expectedChunkLength) {
            sendJson(res, 400, { error: 'invalid_upload_range' })
            return
          }
        }

        let existingSize = 0
        try {
          existingSize = (await stat(partPath)).size
        } catch {
          existingSize = 0
        }
        if (offset > existingSize) {
          sendJson(res, 409, { error: 'upload_offset_mismatch', received: existingSize })
          return
        }

        const handle = await open(partPath, offset === 0 ? 'w' : 'r+')
        try {
          await handle.truncate(offset)
          await pipeline(req, handle.createWriteStream({ start: offset }))
        } finally {
          await handle.close()
        }

        const info = await stat(partPath)
        const received = info.size
        if ((expectedChunkLength > 0 && received - offset !== expectedChunkLength) || (totalKnown && received > total)) {
          activeUploads.delete(sha)
          sendJson(res, 400, { error: 'invalid_upload_size' })
          return
        }
        activeUploads.set(sha, { received })
        if (sync && !sync.done) {
          // 传输中的字节数也实时上报，界面进度条更平滑
          sync.currentBytes = received
          emitSync()
        }

        if (totalKnown && received >= total) {
          const actual = await hashFile(partPath)
          if (actual !== sha) {
            await rm(partPath, { force: true })
            activeUploads.delete(sha)
            sendJson(res, 409, { error: 'hash_mismatch', expected: sha, actual })
            return
          }
          const dest = blobPath(paths.blobsDir, sha)
          await mkdir(dirname(dest), { recursive: true })
          await rename(partPath, dest)
          db.insertBlob(sha, received)
          activeUploads.delete(sha)

          // 落盘即入库：这一张照片立刻出现在电脑界面上，不必等整轮同步结束
          const metas = pendingMeta.get(sha)
          if (metas) {
            let inserted = false
            for (const meta of metas) {
              const { relativePath, displayName } = meta.item
              if (!db.isTombstoned(meta.deviceId, relativePath || '', displayName)) {
                db.insertMedia(mediaItemToInput(meta.deviceId, meta.item, received))
                inserted = true
              }
            }
            if (inserted) {
              // 在文件校验完成后立即通知 renderer；缩略图生成异步进行，不阻塞媒体列表刷新。
              notifyChanged()
              scheduleThumbBackfill()
            }
            pendingMeta.delete(sha)
          }

          if (sync && !sync.done) {
            sync.received += 1
            sync.bytes += received
            sync.currentBytes = 0
            emitSync()
          }
          sendJson(res, 200, { received, complete: true })
          return
        }

        sendJson(res, 200, { received, complete: false })
        return
      }

      // POST /api/v1/sync/prepare —— 手机开始扫描/算指纹前先打招呼
      // 老客户端不发这个请求也不影响（电脑端就按原来的样子，只在收到清单后才显示进度）
      if (method === 'POST' && url.pathname === '/api/v1/sync/prepare') {
        const body = await readJsonBody<SyncPrepareRequest>(req)
        if (!hasSupportedProtocol(body)) {
          sendUnsupportedProtocol(res)
          return
        }
        const device = body?.device
        const deviceId = device?.deviceId ?? ''
        if (!isValidDevice(device)) {
          sendJson(res, 400, { error: 'invalid_device' })
          return
        }
        if (
          [body.total, body.totalBytes, body.hashed, body.hashedBytes].some(
            (value) => value !== undefined && !isSafeNonNegativeInteger(value)
          )
        ) {
          sendJson(res, 400, { error: 'invalid_progress' })
          return
        }
        // 换了一台手机 / 上一轮已结束 → 开一段新的准备会话
        const isNewSession = !sync || sync.deviceId !== deviceId || sync.done
        let deviceRegistered = false
        if (isNewSession) {
          if (deviceId) {
            deviceRegistered = !db.getDevice(deviceId)
            db.upsertDevice({
              id: deviceId,
              name: device.name || deviceId,
              model: device.model,
              androidId: device.androidVersion
            })
          }
          sync = {
            deviceId,
            deviceName: device?.name || deviceId,
            phase: 'preparing',
            needed: 0,
            received: 0,
            bytes: 0,
            currentBytes: 0,
            neededBytes: 0,
            prepareTotal: 0,
            prepareTotalBytes: 0,
            hashed: 0,
            hashedBytes: 0,
            done: false,
            startedAt: Date.now()
          }
        }
        if (deviceRegistered) notifyChanged()
        if (sync) {
          sync.phase = 'preparing'
          if (Number(body?.total) > 0) sync.prepareTotal = Number(body.total)
          if (Number(body?.totalBytes) > 0) sync.prepareTotalBytes = Number(body.totalBytes)
          // 进度只允许前进，避免乱序到达的请求让百分比回退
          sync.hashed = Math.max(sync.hashed ?? 0, Number(body?.hashed) || 0)
          sync.hashedBytes = Math.max(sync.hashedBytes ?? 0, Number(body?.hashedBytes) || 0)
        }
        armPrepareTimer()
        emitSync()
        sendJson(res, 200, { ok: true })
        return
      }

      // POST /api/v1/manifest
      if (method === 'POST' && url.pathname === '/api/v1/manifest') {
        const body = await readJsonBody<ManifestRequest>(req)
        if (!hasSupportedProtocol(body)) {
          sendUnsupportedProtocol(res)
          return
        }
        const items = body?.items ?? []
        const invalidIndex = Array.isArray(items) ? items.findIndex((item) => !isSafeMediaIdentity(item)) : -1
        if (!isValidDevice(body?.device) || !Array.isArray(items) || items.length > 250000 || invalidIndex >= 0) {
          sendJson(res, 400, {
            error: 'invalid_manifest',
            reason: !isValidDevice(body?.device)
              ? 'invalid_device'
              : !Array.isArray(items)
                ? 'items_not_array'
                : items.length > 250000
                  ? 'too_many_items'
                  : 'invalid_media_item',
            ...(invalidIndex >= 0 ? { index: invalidIndex } : {})
          })
          return
        }
        // 用户在电脑上删过的（墓碑）：既不要它再传、也不要它再入库 ——
        // 否则删掉的照片会在手机下次备份时原样长回来。对手机就回"这边已经有了"。
        const tombstoned = body.device?.deviceId ? db.tombstoneKeysOf(body.device.deviceId) : new Set<string>()
        const keyOf = (item: MediaItem): string => `${item.relativePath || ''}\u0000${item.displayName}`
        const needed: string[] = []
        const knownShas = new Set<string>()
        let known = 0
        for (const item of items) {
          if (!item.sha256) continue
          if (tombstoned.has(keyOf(item))) {
            known += 1
            continue
          }
          if (db.blobExists(item.sha256)) {
            knownShas.add(item.sha256)
            known += 1
          } else {
            needed.push(item.sha256)
          }
        }

        // 对比手机当前清单：清单里没有的 = 手机上已删除（电脑保留文件，只打标记）
        let markedMissing = 0
        let ingested = 0
        const device = body.device
        if (device?.deviceId) {
          const deviceWasKnown = Boolean(db.getDevice(device.deviceId))
          db.upsertDevice({
            id: device.deviceId,
            name: device.name || device.deviceId,
            model: device.model,
            androidId: device.androidVersion
          })
          const presentKeys = new Set(
            items.map((item) => `${item.relativePath || ''}\u0000${item.displayName}`)
          )
          markedMissing = db.markMissing(device.deviceId, presentKeys)

          // 流式入库（清单阶段）：
          //   数据已经在电脑上的（上次中断未入库的、断点续传的）→ 立刻建好媒体记录
          //   还需要上传的 → 暂存元数据，等 blob 落盘那一刻入库
          // 只清理同一设备的旧清单，不能 clear 整张表：两台手机同时上传时，
          // 后到的 manifest 会把先到设备的元数据抹掉，blob 虽然传完却没有媒体记录。
          for (const [sha, metas] of pendingMeta) {
            const remaining = metas.filter((meta) => meta.deviceId !== device.deviceId)
            if (remaining.length > 0) pendingMeta.set(sha, remaining)
            else pendingMeta.delete(sha)
          }
          for (const item of items) {
            if (!canIngestItem(item)) continue
            // 删过的条目绝不入库（insertMedia 的 UPSERT 会把 deleted 清回 0，直接"复活"）
            if (tombstoned.has(keyOf(item))) continue
            if (knownShas.has(item.sha256)) {
              const actualSize = db.blobSize(item.sha256)
              if (actualSize === undefined) continue
              db.insertMedia(mediaItemToInput(device.deviceId, item, actualSize))
              ingested += 1
            } else {
              const metas = pendingMeta.get(item.sha256) ?? []
              metas.push({ deviceId: device.deviceId, item })
              pendingMeta.set(item.sha256, metas)
            }
          }
          if (!deviceWasKnown || markedMissing > 0 || ingested > 0) notifyChanged()
        }

        // 开始一次同步会话：电脑端据此显示进度条
        clearPrepareTimer()
        const neededSet = new Set(needed)
        const neededBytes = items
          .filter((item) => neededSet.has(item.sha256))
          .reduce((sum, item) => sum + (item.size || 0), 0)
        sync = {
          deviceId: device?.deviceId ?? '',
          deviceName: device?.name || device?.deviceId || '',
          phase: needed.length === 0 ? 'done' : 'uploading',
          needed: needed.length,
          received: 0,
          bytes: 0,
          currentBytes: 0,
          neededBytes,
          done: needed.length === 0,
          startedAt: Date.now()
        }
        emitSync()

        const payload: ManifestResponse = {
          needed,
          known,
          total: items.length,
          missing: db.countSourceDeleted(device?.deviceId),
          changed: markedMissing
        }
        sendJson(res, 200, payload)
        return
      }

      // POST /api/v1/commit
      if (method === 'POST' && url.pathname === '/api/v1/commit') {
        const body = await readJsonBody<CommitRequest>(req)
        if (!hasSupportedProtocol(body)) {
          sendUnsupportedProtocol(res)
          return
        }
        const device = body?.device
        const items = body?.items
        const invalidIndex = Array.isArray(items) ? items.findIndex((item) => !isSafeMediaIdentity(item)) : -1
        if (!isValidDevice(device) || !Array.isArray(items) || items.length > 250000 || invalidIndex >= 0) {
          sendJson(res, 400, {
            error: 'invalid_commit',
            reason: !isValidDevice(device)
              ? 'invalid_device'
              : !Array.isArray(items)
                ? 'items_not_array'
                : items.length > 250000
                  ? 'too_many_items'
                  : 'invalid_media_item',
            ...(invalidIndex >= 0 ? { index: invalidIndex } : {})
          })
          return
        }
        db.upsertDevice({
          id: device.deviceId,
          name: device.name || device.deviceId,
          model: device.model,
          androidId: device.androidVersion
        })

        const tombstoned = db.tombstoneKeysOf(device.deviceId)
        let inserted = 0
        let skipped = 0
        for (const item of body.items ?? []) {
          if (!item.sha256 || !db.blobExists(item.sha256)) {
            skipped += 1
            continue
          }
          // 电脑上删过的：不让它借 commit 复活（手机端会以为备份成功，这是期望行为）
          if (tombstoned.has(`${item.relativePath || ''}\u0000${item.displayName}`)) {
            skipped += 1
            continue
          }
          const actualSize = db.blobSize(item.sha256)
          if (actualSize === undefined) {
            skipped += 1
            continue
          }
          db.insertMedia(mediaItemToInput(device.deviceId, item, actualSize))
          inserted += 1
        }
        db.touchDeviceSync(device.deviceId)
        if (sync) {
          sync.received = Math.max(sync.received, 0)
          sync.done = true
          sync.phase = 'done'
          emitSync()
        }
        notifyChanged()
        runThumbBackfill()
        sendJson(res, 200, { inserted, skipped, total: (body.items ?? []).length })
        return
      }

      sendJson(res, 404, { error: 'not_found', path: url.pathname })
    }
  })

  // 启动时清理过期分片：断点续传凭据保留 7 天，超过就当地垃圾回收
  void cleanupStaleParts(paths.uploadsDir, 7 * 24 * 60 * 60 * 1000)

  /**
   * 回收站到期清理：启动时一次 + 每 6 小时一次（打开回收站时还会惰性再跑一遍）。
   * 一天一次其实就够，但"删了之后一直不重启"是常态，隔 6 小时兜一次更稳。
   */
  const sweepTrash = (): void => {
    void sweepExpiredTrash(db, paths).then((result) => {
      if (result.count > 0) notifyChanged()
    })
  }
  sweepTrash()
  const trashSweepTimer = setInterval(sweepTrash, 6 * 60 * 60 * 1000)
  trashSweepTimer.unref?.()


  const port = await listenWithFallback(server, options.port ?? DEFAULT_PORT)
  const status: HubStatus = {
    running: true,
    host: '0.0.0.0',
    port,
    addresses: lanAddresses(port),
    pairingCode: pairing.code,
    pairingExpiresAt: pairing.expiresAt
  }
  const stopDiscovery = startDiscovery(options.version, () => status.port, options.tls.fingerprint, () => {
    const now = Date.now()
    // 手机配对成功后会立即再次搜索 mDNS；不要让这次刷新把“已完成”弹窗覆盖回“等待输入”。
    if (now - lastPairSuccessAt < 5000 || now - lastPairingNoticeAt < 10000) return
    lastPairingNoticeAt = now
    options.onPairingRequested?.()
  })
  const stopMdns = startMdns({
    port,
    version: options.version,
    fingerprint: options.tls.fingerprint
  })

  return {
    status,
    refreshPairingCode: () => {
      pairing = newPairingState()
      status.pairingCode = pairing.code
      status.pairingExpiresAt = pairing.expiresAt
    },
    stop: () =>
      new Promise<void>((resolve) => {
        clearPrepareTimer()
        clearThumbBackfillTimer()
        clearInterval(trashSweepTimer)
        stopDiscovery()
        stopMdns()
        server.close(() => resolve())
      })
  }
}
