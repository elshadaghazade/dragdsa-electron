// Preload script — runs in an isolated context with access to a limited
// subset of Node + Electron APIs. Exposes a typed bridge to the renderer.

import { contextBridge, ipcRenderer } from 'electron'
import type { DragsaConfig } from './config'
import type { BackendStatus } from './backend'

const api = {
  /** Read persistent desktop-side config (brainUrl, token, …). */
  getConfig: (): Promise<DragsaConfig> => ipcRenderer.invoke('config:get'),

  /** Persist config + auto-restart the tools binary so it picks up new env. */
  setConfig: (patch: Partial<DragsaConfig>): Promise<DragsaConfig> =>
    ipcRenderer.invoke('config:set', patch),

  /** Force a backend restart (e.g. if the user changes the brain URL). */
  restartBackend: (): Promise<BackendStatus> => ipcRenderer.invoke('backend:restart'),

  /** Current backend status — useful for a "Connected / Disconnected" indicator. */
  getBackendStatus: (): Promise<BackendStatus> => ipcRenderer.invoke('backend:status'),

  /** Subscribe to backend status changes. Returns an unsubscribe fn. */
  onBackendStatus: (cb: (s: BackendStatus) => void): (() => void) => {
    const fn = (_e: unknown, s: BackendStatus): void => cb(s)
    ipcRenderer.on('backend:status', fn)
    return () => ipcRenderer.off('backend:status', fn)
  },

  /** Open the app's log folder in Finder/Explorer. */
  showLogs: (): Promise<void> => ipcRenderer.invoke('logs:show'),

  /** One-shot info for the renderer to show in an About / Diagnostics panel. */
  info: (): Promise<{
    version: string
    platform: NodeJS.Platform
    packaged: boolean
    rendererOrigin: string
  }> => ipcRenderer.invoke('app:info'),
}

contextBridge.exposeInMainWorld('dragsa', api)

export type DragsaBridge = typeof api
