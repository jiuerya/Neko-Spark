import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { DragPrepareResult, ExportQuery, GmApi, SyncProgress, TaskProgress } from '@shared/types'

const api: GmApi = {
  getStatus: () => ipcRenderer.invoke('app:status'),
  refreshPairingCode: () => ipcRenderer.invoke('app:refreshPairingCode'),
  openDataDir: () => ipcRenderer.invoke('app:openDataDir'),
  openStickersDir: () => ipcRenderer.invoke('app:openStickersDir'),
  chooseDataDir: () => ipcRenderer.invoke('app:chooseDataDir'),
  restartApp: () => ipcRenderer.invoke('app:restart'),
  pickFolder: (title?: string) => ipcRenderer.invoke('app:pickFolder', title),
  importFolder: (dir: string, deviceId?: string) => ipcRenderer.invoke('task:importFolder', dir, deviceId),
  exportTo: (targetDir: string, query: ExportQuery) => ipcRenderer.invoke('task:exportTo', targetDir, query),
  mergeDevices: (sourceDeviceId: string, targetDeviceId: string) =>
    ipcRenderer.invoke('task:mergeDevices', sourceDeviceId, targetDeviceId),
  splitDevice: (deviceId: string) => ipcRenderer.invoke('task:splitDevice', deviceId),
  prepareDrag: (mediaIds: number[]) =>
    ipcRenderer.invoke('media:prepareDrag', mediaIds) as Promise<DragPrepareResult>,
  // 用 send 而不是 invoke：主进程会进入系统模态拖放循环，等它返回会把渲染端一起卡住
  startDrag: (mediaIds: number[]) => ipcRenderer.send('media:dragOut', mediaIds),
  saveVideoThumb: (mediaId: number, bytes: ArrayBuffer) =>
    ipcRenderer.invoke('media:saveVideoThumb', mediaId, bytes) as Promise<boolean>,
  markVideoThumbFailed: (mediaId: number) =>
    ipcRenderer.invoke('media:videoThumbFailed', mediaId) as Promise<void>,
  onProgress: (callback: (progress: TaskProgress) => void) => {
    const listener = (_event: IpcRendererEvent, progress: TaskProgress): void => callback(progress)
    ipcRenderer.on('task:progress', listener)
    return () => ipcRenderer.removeListener('task:progress', listener)
  },
  onSyncProgress: (callback: (progress: SyncProgress) => void) => {
    const listener = (_event: IpcRendererEvent, progress: SyncProgress): void => callback(progress)
    ipcRenderer.on('sync:progress', listener)
    return () => ipcRenderer.removeListener('sync:progress', listener)
  },
  onPairingRequested: (callback: () => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('pairing:requested', listener)
    return () => ipcRenderer.removeListener('pairing:requested', listener)
  },
  onPairing: (callback: () => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('pairing:completed', listener)
    return () => ipcRenderer.removeListener('pairing:completed', listener)
  },
  onDataChanged: (callback: () => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('data:changed', listener)
    return () => ipcRenderer.removeListener('data:changed', listener)
  }
}

contextBridge.exposeInMainWorld('gm', api)
