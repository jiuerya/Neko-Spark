import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { AlbumRecord, AppStatus, DeviceRecord, MediaRecord, SyncProgress, TaskProgress } from '@shared/types'
import Sidebar, { ALL_DEVICES, type ViewKey } from './components/Sidebar'
import SettingsView from './components/SettingsView'
import PairingPopup from './components/PairingPopup'
import Viewer from './components/Viewer'
import AlbumsView from './views/AlbumsView'
import DevicesView from './views/DevicesView'
import MediaGridView from './views/MediaGridView'
import TrashView from './views/TrashView'
import {
  apiBase,
  fetchDevices,
  fetchMedia,
  fetchTrash,
  purgeMedia,
  renameDevice,
  restoreMedia,
  setFavorite,
  trashMedia
} from './api'
import { formatCount, formatSize } from './utils/format'
import { useBackgrounds, useUserStickers } from './hooks/useUserStickers'
import { useCompactGrid } from './hooks/useCompactGrid'
import { useViewerHistory } from './hooks/useViewerHistory'
import { clearSelection, selectionList } from './hooks/useSelection'
import { requestVideoThumb } from './utils/videoThumb'
import mascotHi from './assets/stickers/mascot-hi.svg'
import mascotLove from './assets/stickers/mascot-love.svg'
import mascotSleep from './assets/stickers/mascot-sleep.svg'
import mascotThink from './assets/stickers/mascot-think.svg'
import mascotHappy from './assets/stickers/mascot-happy.svg'
import mascotStar from './assets/stickers/mascot-star.svg'

const VIEW_META: Record<ViewKey, { title: string; subtitle: string }> = {
  timeline: { title: '全部', subtitle: '所有照片和视频，按拍摄时间排列' },
  albums: { title: '相册', subtitle: '按手机中的相册（文件夹）浏览' },
  favorites: { title: '收藏', subtitle: '标记为收藏的媒体' },
  videos: { title: '视频', subtitle: '仅显示视频' },
  trash: { title: '回收站', subtitle: '删掉的照片先放这里，到期自动彻底删除' },
  devices: { title: '设备', subtitle: '备份、导入导出与本地服务' },
  settings: { title: '设置', subtitle: '存储位置、端口与同步选项' }
}

export default function App(): JSX.Element {
  const [status, setStatus] = useState<AppStatus | null>(null)
  const [pairingPopupStatus, setPairingPopupStatus] = useState<AppStatus | null>(null)
  const [pairingPopupPending, setPairingPopupPending] = useState(false)
  const [active, setActive] = useState<ViewKey>('timeline')
  const [media, setMedia] = useState<MediaRecord[]>([])
  const [devices, setDevices] = useState<DeviceRecord[]>([])
  const [activeAlbum, setActiveAlbum] = useState<AlbumRecord | null>(null)
  const [activeDeviceId, setActiveDeviceId] = useState<string>(ALL_DEVICES)
  const [showDeleted, setShowDeleted] = useState<boolean>(
    () => localStorage.getItem('gm.showDeleted') !== '0'
  )
  const [progress, setProgress] = useState<TaskProgress | null>(null)
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null)
  // 回收站列表（只在回收站视图里用，按需拉取）
  const [trashItems, setTrashItems] = useState<MediaRecord[]>([])
  const [trashRetention, setTrashRetention] = useState(30)
  const { viewer, navigate, replace, back, forward } = useViewerHistory()
  const { toggleCompact } = useCompactGrid()
  /** 最近一次"移入回收站"的 id：Ctrl+Z 一键反悔（不新增任何界面元素） */
  const lastTrashed = useRef<number[] | null>(null)

  // Tab 键切换「按日期分组 ⇄ 紧凑模式（不显示日期标题，日期看滚动条气泡）」。
  // 查看大图时不抢这个键；焦点在输入框里也放行，免得挡住正常操作。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab' || event.ctrlKey || event.altKey || event.metaKey) return
      if (viewer) return
      const target = event.target as HTMLElement | null
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      ) {
        return
      }
      event.preventDefault()
      toggleCompact()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [viewer, toggleCompact])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const clearTimer = useRef<number | null>(null)
  const lastSyncRefresh = useRef({ startedAt: 0, received: 0 })
  const refreshGeneration = useRef(0)

  const base = status?.hub.running ? apiBase(status.hub.port) : ''
  const userStickers = useUserStickers(base)
  const backgrounds = useBackgrounds(base, status?.backgroundVersion ?? 0)

  /** 第一张固定给侧栏，其余按会话随机轮换，保证每张贴图都有机会出现 */
  const stickerOffset = useMemo(() => Math.floor(Math.random() * 1000), [userStickers.length])
  const pickSticker = useCallback(
    (index: number, fallback: string): string => {
      if (userStickers.length === 0) return fallback
      if (userStickers.length === 1) return userStickers[0]
      const pool = userStickers.slice(1)
      return pool[(index + stickerOffset) % pool.length]
    },
    [userStickers, stickerOffset]
  )

  const refreshStatus = useCallback(async () => {
    try {
      const next = await window.gm.getStatus()
      setStatus(next)
      return next
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return null
    }
  }, [])

  const refreshLibrary = useCallback(
    async (api: string) => {
      if (!api) return
      const generation = ++refreshGeneration.current
      try {
        // 状态一起刷新：回收站的角标数就在 status.counts.trash 里，
        // 不刷的话删完东西侧栏数字要等 15 秒轮询才变
        const [mediaList, deviceList] = await Promise.all([fetchMedia(api), fetchDevices(api), refreshStatus()])
        // 上传期间可能在前一个请求完成前再次触发刷新；旧响应不能覆盖刚收到的新列表。
        if (generation !== refreshGeneration.current) return
        setMedia(mediaList)
        setDevices(deviceList)
        setError('')
      } catch (err) {
        if (generation === refreshGeneration.current) {
          setError(err instanceof Error ? err.message : String(err))
        }
      } finally {
        if (generation === refreshGeneration.current) setLoading(false)
      }
    },
    [refreshStatus]
  )

  useEffect(() => {
    void refreshStatus().then((next) => {
      if (next?.hub.running) void refreshLibrary(apiBase(next.hub.port))
    })
  }, [refreshStatus, refreshLibrary])

  const mediaCountRef = useRef(-1)
  useEffect(() => {
    if (status?.counts.media !== undefined) mediaCountRef.current = status.counts.media
  }, [status])

  useEffect(() => {
    const timer = window.setInterval(async () => {
      const next = await refreshStatus()
      if (!next?.hub.running) return
      const api = apiBase(next.hub.port)
      // 只有数量变化（或首次拿到地址）时才重新拉取列表，避免大库定时全量刷新
      if (!base || next.counts.media !== mediaCountRef.current) {
        mediaCountRef.current = next.counts.media
        void refreshLibrary(api)
      }
    }, 15000)
    return () => window.clearInterval(timer)
  }, [base, refreshStatus, refreshLibrary])

  /**
   * 手机上传时，电脑端每落盘一个文件就会通知一次（几千次）。
   * 每次都全量重拉会很卡，所以这里限流：两次刷新之间至少隔 MIN_GAP。
   * 拖尾补一次保证最后一次变化不会丢 —— 突发结束后界面最多晚 MIN_GAP 刷新，
   * 观感上仍是"照片边传边出现"。
   */
  const MIN_REFRESH_GAP = 600
  const refreshTimer = useRef<number | null>(null)
  const lastRefreshAt = useRef(0)
  const scheduleRefresh = useCallback(
    (api: string) => {
      if (!api) return
      const elapsed = Date.now() - lastRefreshAt.current
      if (elapsed >= MIN_REFRESH_GAP) {
        lastRefreshAt.current = Date.now()
        void refreshLibrary(api)
        return
      }
      if (refreshTimer.current !== null) return // 已经排了一个补刷，不重复排
      refreshTimer.current = window.setTimeout(() => {
        refreshTimer.current = null
        lastRefreshAt.current = Date.now()
        void refreshLibrary(api)
      }, MIN_REFRESH_GAP - elapsed)
    },
    [refreshLibrary]
  )

  useEffect(() => {
    const offData = window.gm.onDataChanged(() => {
      if (base) scheduleRefresh(base)
    })
    const offProgress = window.gm.onProgress((next) => {
      setProgress(next)
      if (clearTimer.current) window.clearTimeout(clearTimer.current)
      if (next.phase === 'done' || next.phase === 'error') {
        clearTimer.current = window.setTimeout(() => setProgress(null), 8000)
      }
    })
    const offSync = window.gm.onSyncProgress((next) => {
      setSyncProgress(next)
      // data:changed 是主要通知；同步进度再兜底触发一次，避免某些系统/并发场景丢掉单个文件的刷新事件。
      const previous = lastSyncRefresh.current
      if (base && (next.startedAt !== previous.startedAt || next.received > previous.received)) {
        lastSyncRefresh.current = { startedAt: next.startedAt, received: next.received }
        if (next.received > 0) scheduleRefresh(base)
      }
      if (next.done) {
        window.setTimeout(() => {
          setSyncProgress((current) => (current && current.startedAt === next.startedAt ? null : current))
        }, 8000)
      }
    })
    const offPairingRequested = window.gm.onPairingRequested(() => {
      void window.gm.getStatus().then((next) => {
        setStatus(next)
        setPairingPopupPending(true)
        setPairingPopupStatus(next)
      })
    })
    const offPairing = window.gm.onPairing(() => {
      // token 只通过本地 IPC 取回，用于桌面端提示框；Hub HTTP 和 mDNS 不会返回它。
      void window.gm.getStatus().then((next) => {
        setStatus(next)
        setPairingPopupPending(false)
        setPairingPopupStatus(next)
        // 配对接口会先登记轻量设备记录；主动补刷一次，避免 data:changed 在页面初始加载期间丢失。
        if (next.hub.running) scheduleRefresh(apiBase(next.hub.port))
      })
    })
    return () => {
      offData()
      offProgress()
      offSync()
      offPairingRequested()
      offPairing()
      if (refreshTimer.current !== null) {
        window.clearTimeout(refreshTimer.current)
        refreshTimer.current = null
      }
    }
  }, [base, scheduleRefresh])

  // 设备被合并/移除后，筛选自动回到"全部设备"
  useEffect(() => {
    if (activeDeviceId !== ALL_DEVICES && !devices.some((device) => device.id === activeDeviceId)) {
      setActiveDeviceId(ALL_DEVICES)
    }
  }, [devices, activeDeviceId])

  /**
   * 「退出当前这一层」（等同 Esc 的语义），按层次从里往外：
   *   ① 正在看图/视频 → 关掉查看器
   *   ② 正在看某个相册（相册详情）→ 退回相册列表
   *   ③ 已经在最外层 → 保留"前进重开"（没有前进记录时就是空操作，不会显得像坏了）
   */
  const exitLayer = useCallback((): void => {
    if (viewer) navigate(null)
    else if (activeAlbum) setActiveAlbum(null)
    else forward()
  }, [viewer, navigate, activeAlbum, forward])

  // 鼠标侧键（用户 2026-09-25 实测反馈后定的映射）：
  //
  //   ⚠️ 用户鼠标上：**"下/后侧键"发的是 DOM button 3**（不是常说的 4）。
  //   前两轮把它当成 4、把"撤回上一步"挂在 3 上，结果他按后侧键时走的是
  //   `back()` —— 没有历史记录就是个**静默空操作**，所以在相册详情里"按了没有任何反应"
  //   （2026-09-24 那次"下侧键按下去没反应"也是同一个原因）。
  //
  //   button 3（用户的"下/后侧键"）= **退出当前这一层（等同 Esc）** —— 他要的就是这个
  //   button 4（用户的"上/前侧键"）= **沿历史撤回上一步**（和浏览器一致）；
  //            查看器没开时也当作"退出一层"（浏览器的后退本来就是这样，顺手让两个键都能退出相册，
  //            免得物理映射再猜错时又把他卡在某个界面里出不来）
  useEffect(() => {
    const onMouseDown = (event: MouseEvent): void => {
      if (event.button === 3 || event.button === 4) event.preventDefault()
    }
    const onMouseUp = (event: MouseEvent): void => {
      if (event.button === 3) {
        event.preventDefault()
        exitLayer()
      } else if (event.button === 4) {
        event.preventDefault()
        if (viewer) back()
        else exitLayer()
      }
    }
    window.addEventListener('mousedown', onMouseDown)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [back, exitLayer, viewer])

  const deviceNames = useMemo(
    () => new Map(devices.map((device) => [device.id, device.name])),
    [devices]
  )

  const visibleMedia = useMemo(() => {
    let scoped: MediaRecord[]
    if (activeDeviceId === ALL_DEVICES) {
      scoped = media
    } else {
      // 选中主设备 → 连同其副设备一起显示；选中副设备 → 显示整组
      const self = devices.find((device) => device.id === activeDeviceId)
      const rootId = self?.mergedInto ?? activeDeviceId
      const groupIds = new Set<string>([rootId])
      for (const device of devices) {
        if (device.mergedInto === rootId) groupIds.add(device.id)
      }
      scoped = media.filter((item) => groupIds.has(item.deviceId))
    }
    return showDeleted ? scoped : scoped.filter((item) => !item.sourceDeleted)
  }, [media, devices, activeDeviceId, showDeleted])

  // 相册列表由当前可见媒体实时推导，保证与"显示已删除"开关一致
  const visibleAlbums = useMemo(() => {
    const map = new Map<string, AlbumRecord>()
    for (const item of visibleMedia) {
      const key = `${item.deviceId}\u0000${item.bucketId}`
      const ts = item.dateTaken ?? item.dateModified ?? item.dateAdded ?? 0
      let album = map.get(key)
      if (!album) {
        album = {
          bucketId: item.bucketId,
          bucketName: item.bucketName || item.bucketId,
          relativePath: item.relativePath,
          deviceId: item.deviceId,
          count: 0,
          coverMediaId: item.id,
          latestDate: ts
        }
        map.set(key, album)
      }
      album.count += 1
      if (ts > album.latestDate) {
        album.latestDate = ts
        album.coverMediaId = item.id
      }
    }
    return [...map.values()].sort((a, b) => b.latestDate - a.latestDate)
  }, [visibleMedia])

  const deletedInScope = useMemo(() => visibleMedia.filter((item) => item.sourceDeleted).length, [visibleMedia])
  const deletedTotal = useMemo(() => media.filter((item) => item.sourceDeleted).length, [media])

  const openViewer = useCallback(
    (list: MediaRecord[], target: MediaRecord, mode: 'library' | 'trash' = 'library') => {
      const index = list.findIndex((item) => item.id === target.id)
      navigate({ list, index: index < 0 ? 0 : index, mode })
    },
    [navigate]
  )

  const toggleFavorite = useCallback(
    async (item: MediaRecord) => {
      if (!base) return
      const next = !item.isFavorite
      setMedia((current) =>
        current.map((entry) => (entry.id === item.id ? { ...entry, isFavorite: next } : entry))
      )
      replace((current) =>
        current
          ? {
              ...current,
              list: current.list.map((entry) =>
                entry.id === item.id ? { ...entry, isFavorite: next } : entry
              )
            }
          : current
      )
      try {
        await setFavorite(base, item.id, next)
      } catch {
        void refreshLibrary(base)
      }
    },
    [base, refreshLibrary, replace]
  )

  // ---------- 删除 / 回收站 ----------

  /** 把被删掉的项从查看器的列表里摘掉（删完自动看下一张；列表空了就关掉查看器） */
  const dropFromViewer = useCallback(
    (ids: number[]) => {
      if (ids.length === 0) return
      const drop = new Set(ids)
      replace((current) => {
        if (!current) return current
        const list = current.list.filter((item) => !drop.has(item.id))
        if (list.length === 0) return null
        return { ...current, list, index: Math.min(current.index, list.length - 1) }
      })
    },
    [replace]
  )

  /** 移入回收站（软删除）：文件还在，30 天内随时能恢复 */
  const handleTrash = useCallback(
    async (ids: number[]) => {
      if (!base || ids.length === 0) return
      try {
        await trashMedia(base, ids)
        lastTrashed.current = ids // Ctrl+Z 反悔用
        dropFromViewer(ids)
        clearSelection()
        await refreshLibrary(base)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [base, dropFromViewer, refreshLibrary]
  )

  /** 从回收站恢复：放回原来的相册位置 */
  const handleRestore = useCallback(
    async (ids: number[]) => {
      if (!base || ids.length === 0) return
      try {
        await restoreMedia(base, ids)
        dropFromViewer(ids)
        clearSelection()
        await refreshLibrary(base)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [base, dropFromViewer, refreshLibrary]
  )

  /** 彻底删除（记录 + 磁盘文件，不可恢复） */
  const handlePurge = useCallback(
    async (ids: number[]) => {
      if (!base || ids.length === 0) return
      try {
        await purgeMedia(base, ids)
        dropFromViewer(ids)
        clearSelection()
        await refreshLibrary(base)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [base, dropFromViewer, refreshLibrary]
  )

  /**
   * 视频首帧：整库排队慢慢补（用户库里有 422 个视频，靠"滑到才抽"太被动）。
   * `requestVideoThumb` 自己会去重（每个视频每会话只试一次），队列是串行的、
   * 每张之间还歇一下，所以不会卡界面；正在放视频时会自动暂停。
   *
   * 另外**每 60 秒再扫一遍**：抽帧超时/被主进程拒掉的那些会被放回可重试状态，
   * 靠这个定时扫来自愈 —— 否则队列一旦排空，它们就永远是"没图"（实测卡在 346/422）。
   */
  const mediaRef = useRef<MediaRecord[]>([])
  useEffect(() => {
    mediaRef.current = media
  }, [media])
  useEffect(() => {
    if (!base) return
    const sweep = (): void => {
      for (const item of mediaRef.current) {
        if (item.kind === 'video' && item.thumbState !== 'ready') requestVideoThumb(item.id, base)
      }
    }
    sweep()
    const timer = window.setInterval(sweep, 60000)
    return () => window.clearInterval(timer)
  }, [base])

  // 回收站列表：进回收站视图时拉取；库里一有变化（角标数变了）也跟着更新
  useEffect(() => {
    if (active !== 'trash' || !base) return
    let cancelled = false
    void fetchTrash(base, activeDeviceId === ALL_DEVICES ? undefined : activeDeviceId)
      .then((data) => {
        if (cancelled) return
        setTrashItems(data.media)
        setTrashRetention(data.retentionDays)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [active, base, activeDeviceId, status?.counts.trash])

  /**
   * 网格里的键盘操作：
   *   Delete = 删除选中的（回收站里则是彻底删除）
   *   Ctrl+Z = 反悔上一次删除（恢复；刻意不新增任何界面元素 —— 这个界面保持无提示条）
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return
      }
      const ctrl = event.ctrlKey || event.metaKey
      if (ctrl && event.key.toLowerCase() === 'z') {
        const ids = lastTrashed.current
        if (!ids || ids.length === 0) return
        event.preventDefault()
        lastTrashed.current = null
        void handleRestore(ids)
        return
      }
      if (event.key !== 'Delete' || ctrl || event.altKey) return
      if (viewer) return // 查看器打开时由 Viewer 处理（删的是当前这一张）
      if (active === 'settings' || active === 'devices') return
      const ids = selectionList()
      if (ids.length === 0) return
      event.preventDefault()
      if (active === 'trash') void handlePurge(ids)
      else void handleTrash(ids)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [active, viewer, handleTrash, handleRestore, handlePurge])

  const handleImport = useCallback(async (deviceId?: string) => {
    const dir = await window.gm.pickFolder('选择要导入的相册文件夹（例如手机相册导出的目录）')
    if (!dir) return
    setProgress(null)
    try {
      await window.gm.importFolder(dir, deviceId)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const handleExport = useCallback(async (deviceId?: string) => {
    const dir = await window.gm.pickFolder('选择导出目标文件夹（会把原始文件按相册结构写回）')
    if (!dir) return
    setProgress(null)
    try {
      await window.gm.exportTo(dir, deviceId ? { deviceId } : {})
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const handleMerge = useCallback(
    async (sourceDeviceId: string, targetDeviceId: string) => {
      try {
        await window.gm.mergeDevices(sourceDeviceId, targetDeviceId)
        if (base) await refreshLibrary(base)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [base, refreshLibrary]
  )

  const handleSplit = useCallback(
    async (deviceId: string) => {
      try {
        await window.gm.splitDevice(deviceId)
        if (base) await refreshLibrary(base)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [base, refreshLibrary]
  )

  const handleRename = useCallback(
    async (deviceId: string, name: string) => {
      if (!base) return
      try {
        await renameDevice(base, deviceId, name)
        await refreshLibrary(base)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [base, refreshLibrary]
  )

  const favorites = useMemo(() => visibleMedia.filter((item) => item.isFavorite), [visibleMedia])
  const videos = useMemo(() => visibleMedia.filter((item) => item.kind === 'video'), [visibleMedia])
  const albumMedia = useMemo(
    () => (activeAlbum ? visibleMedia.filter((item) => item.bucketId === activeAlbum.bucketId) : []),
    [activeAlbum, visibleMedia]
  )

  const meta = VIEW_META[active]
  const hubRunning = status?.hub.running ?? false
  const activeDeviceName = activeDeviceId === ALL_DEVICES ? '' : deviceNames.get(activeDeviceId) ?? ''

  const selectView = (key: ViewKey): void => {
    setActive(key)
    setActiveAlbum(null)
    clearSelection() // 换视图就不该还留着上一批选中的（和资源管理器一致）
  }

  const selectDevice = (deviceId: string): void => {
    setActiveDeviceId(deviceId)
    setActiveAlbum(null)
    clearSelection()
    if (active === 'devices' || active === 'settings') setActive('timeline')
  }

  const toggleShowDeleted = useCallback((value: boolean): void => {
    setShowDeleted(value)
    localStorage.setItem('gm.showDeleted', value ? '1' : '0')
  }, [])

  const renderContent = (): JSX.Element => {
    if (active === 'settings') {
      return (
        <SettingsView
          status={status}
          sticker={pickSticker(6, mascotStar)}
          stickerCount={userStickers.length}
          showDeleted={showDeleted}
          onToggleDeleted={toggleShowDeleted}
        />
      )
    }
    if (active === 'devices') {
      return (
        <DevicesView
          status={status}
          devices={devices}
          progress={progress}
          sticker={pickSticker(5, mascotHappy)}
          sourceDeletedCount={deletedTotal}
          syncProgress={syncProgress}
          onImport={(deviceId) => void handleImport(deviceId)}
          onExportAll={() => void handleExport()}
          onExportDevice={(deviceId) => void handleExport(deviceId)}
          onMerge={(sourceId, targetId) => void handleMerge(sourceId, targetId)}
          onSplit={(deviceId) => void handleSplit(deviceId)}
          onRename={(deviceId, name) => void handleRename(deviceId, name)}
          onOpenDataDir={() => void window.gm.openDataDir()}
        />
      )
    }
    if (active === 'trash') {
      return (
        <TrashView
          media={trashItems}
          base={base}
          retentionDays={trashRetention}
          onOpen={(item) => openViewer(trashItems, item, 'trash')}
          onRestore={(ids) => void handleRestore(ids)}
          onPurge={(ids) => void handlePurge(ids)}
          emptyImage={backgrounds[3] ?? pickSticker(4, mascotThink)}
          pageBackground={backgrounds[3] ?? undefined}
        />
      )
    }
    if (active === 'albums' && !activeAlbum) {
      return (
        <AlbumsView
          albums={visibleAlbums}
          base={base}
          showDevice={activeDeviceId === ALL_DEVICES}
          deviceName={(id) => deviceNames.get(id) ?? id}
          emptyImage={backgrounds[3] ?? pickSticker(4, mascotThink)}
          pageBackground={backgrounds[3] ?? undefined}
          onOpenAlbum={setActiveAlbum}
        />
      )
    }

    const list =
      active === 'timeline'
        ? visibleMedia
        : active === 'favorites'
          ? favorites
          : active === 'videos'
            ? videos
            : albumMedia

    const empty = {
      timeline: {
        title: activeDeviceName ? `「${activeDeviceName}」还没有照片` : '还没有照片',
        hint: '点击左侧"设备"里的"导入文件夹"，或等手机端（协议 v1）同步过来。',
        image: backgrounds[0] ?? pickSticker(1, mascotHi)
      },
      favorites: {
        title: '还没有收藏',
        hint: '在查看器里点"收藏"即可加入这里。',
        image: backgrounds[1] ?? pickSticker(2, mascotLove)
      },
      videos: {
        title: '还没有视频',
        hint: '备份或导入包含视频的文件夹后会出现。',
        image: backgrounds[2] ?? pickSticker(3, mascotSleep)
      },
      albums: {
        title: '相册为空',
        hint: '这个相册里暂时没有内容。',
        image: backgrounds[3] ?? pickSticker(4, mascotThink)
      }
    }[active]

    return (
      <MediaGridView
        media={list}
        base={base}
        onOpen={(item) => openViewer(list, item)}
        emptyTitle={empty.title}
        emptyHint={empty.hint}
        emptyImage={empty.image}
        pageBackground={
          (active === 'timeline'
            ? backgrounds[0]
            : active === 'favorites'
              ? backgrounds[1]
              : active === 'videos'
                ? backgrounds[2]
                : backgrounds[3]) ?? undefined
        }
        action={
          active === 'timeline' ? (
            <button type="button" className="btn btn-primary" onClick={() => void handleImport()}>
              导入文件夹
            </button>
          ) : null
        }
      />
    )
  }

  return (
    <div className="app">
      {pairingPopupStatus ? (
        <PairingPopup
          status={pairingPopupStatus}
          pending={pairingPopupPending}
          onClose={() => {
            setPairingPopupStatus(null)
            setPairingPopupPending(false)
          }}
        />
      ) : null}
      <Sidebar
        active={active}
        onSelect={selectView}
        devices={devices}
        activeDeviceId={activeDeviceId}
        onSelectDevice={selectDevice}
        mascot={userStickers[0] ?? mascotSleep}
        trashCount={status?.counts.trash ?? 0}
      />

      <main className="main">
        <header className="topbar">
          <div className="topbar-title">
            {activeAlbum ? (
              <div className="title-with-back">
                <button type="button" className="btn btn-ghost" onClick={() => setActiveAlbum(null)}>
                  返回相册
                </button>
                <h1>{activeAlbum.bucketName}</h1>
                <p>
                  {formatCount(albumMedia.length)} 项 · {activeAlbum.relativePath || '根目录'}
                  {activeDeviceId === ALL_DEVICES
                    ? ` · ${deviceNames.get(activeAlbum.deviceId) ?? activeAlbum.deviceId}`
                    : ''}
                </p>
              </div>
            ) : (
              <>
                <h1>{meta.title}</h1>
                <p>{meta.subtitle}</p>
              </>
            )}
          </div>

          <div className="topbar-right">
            {loading ? <span className="muted">加载中...</span> : null}
            {activeDeviceName ? (
              <span className="pill pill-device">只看：{activeDeviceName}</span>
            ) : (
              <span className="pill">全部设备（合并）</span>
            )}
            <span className="pill">
              <span className="pill-dot" />
              {formatCount(active === 'trash' ? trashItems.length : visibleMedia.length)} 项媒体
            </span>
            {deletedInScope > 0 ? (
              <span className="pill pill-deleted" title="这些文件在手机上已删除，电脑仍保留备份">
                已删除 {formatCount(deletedInScope)}
              </span>
            ) : null}
            <span className={`pill ${hubRunning ? 'pill-ok' : 'pill-err'}`}>
              <span className="pill-dot" />
              {hubRunning ? `服务运行中 · ${status?.hub.port}` : '服务未运行'}
            </span>
          </div>
        </header>

        {syncProgress &&
        !syncProgress.done &&
        (syncProgress.phase === 'preparing' || syncProgress.needed > 0) ? (
          <div className="sync-banner">
            <div
              className="sync-strip"
              title={
                syncProgress.phase === 'preparing'
                  ? `${syncProgress.deviceName} 正在准备`
                  : `${syncProgress.deviceName} 正在上传`
              }
            >
              <div
                className="sync-strip-fill"
                style={{
                  width: `${(() => {
                    if (syncProgress.phase === 'preparing') {
                      const total = syncProgress.prepareTotalBytes ?? 0
                      if (total <= 0) return 100 // 未知总量：走满格做"无限流动"的观感
                      return Math.min(100, Math.round(((syncProgress.hashedBytes ?? 0) / total) * 100))
                    }
                    return Math.min(
                      100,
                      Math.round((syncProgress.received / Math.max(1, syncProgress.needed)) * 100)
                    )
                  })()}%`
                }}
              />
            </div>
            <div className="sync-banner-text">
              <span className="sync-banner-dot" />
              <strong>{syncProgress.deviceName}</strong>
              {syncProgress.phase === 'preparing' ? (
                <>
                  <span>正在准备（手机扫描相册 / 计算文件指纹）</span>
                  {syncProgress.prepareTotal ? (
                    <span className="sync-banner-size">
                      {formatCount(syncProgress.hashed ?? 0)} / {formatCount(syncProgress.prepareTotal)} 个
                      {syncProgress.prepareTotalBytes
                        ? `　${formatSize(syncProgress.hashedBytes ?? 0)} / ${formatSize(syncProgress.prepareTotalBytes)}`
                        : ''}
                    </span>
                  ) : (
                    <span className="sync-banner-size">这步可能要几分钟，请保持手机与电脑连接</span>
                  )}
                </>
              ) : (
                <>
                  <span>
                    正在接收 {formatCount(syncProgress.received)} / {formatCount(syncProgress.needed)} 个文件
                  </span>
                  {syncProgress.neededBytes > 0 ? (
                    <span className="sync-banner-size">
                      {formatSize(syncProgress.bytes + (syncProgress.currentBytes ?? 0))} /{' '}
                      {formatSize(syncProgress.neededBytes)}
                    </span>
                  ) : null}
                </>
              )}
            </div>
          </div>
        ) : null}

        <div className={`content ${active === 'settings' || active === 'devices' ? '' : 'content-grid'}`}>
          {error ? <div className="alert">{error}</div> : null}
          {renderContent()}
        </div>
      </main>

      {viewer ? (
        <Viewer
          items={viewer.list}
          index={viewer.index}
          base={base}
          deviceName={deviceNames.get(viewer.list[viewer.index]?.deviceId ?? '') ?? ''}
          mode={viewer.mode ?? 'library'}
          onClose={() => navigate(null)}
          onIndexChange={(index) =>
            navigate((current) => (current ? { ...current, index } : current))
          }
          onToggleFavorite={(item) => void toggleFavorite(item)}
          onDelete={(item) =>
            viewer.mode === 'trash' ? void handlePurge([item.id]) : void handleTrash([item.id])
          }
          onRestore={(item) => void handleRestore([item.id])}
        />
      ) : null}
    </div>
  )
}
