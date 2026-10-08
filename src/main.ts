// Electron main process. Responsibilities:
//   • Create the BrowserWindow (loads Vite dev server in dev, host server in prod)
//   • Manage the tools backend child process lifecycle
//   • Persist + serve desktop-side config (brainUrl, token) via IPC
//   • Single-instance lock (so two app launches don't both spawn backends)
//
// The renderer is intentionally NOT allowed to know about the brain URL or
// token — it talks to a same-origin /api/* on the host server, and the host
// server injects the Bearer header. No CORS gymnastics required.

import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { loadConfig, saveConfig, isValidWsUrl } from './config'
import * as backend from './backend'
import { startHostServer, type RunningServer } from './host-server'
import { installAppMenu } from './menu'
import { autoUpdater } from 'electron-updater'

// ────────────────────────────────────────────────────────────────────────────
// Single-instance: avoid two backends spawning from two app launches.
// ────────────────────────────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
  process.exit(0)
}

const isDev = process.env.DRAGSA_ELECTRON_DEV === '1'
const DEV_RENDERER_URL = process.env.DRAGSA_ELECTRON_RENDERER_URL || 'http://localhost:5173'

console.log('[main] starting; isDev=' + isDev + ' DRAGSA_ELECTRON_DEV=' + (process.env.DRAGSA_ELECTRON_DEV || '(unset)'))

let mainWindow: BrowserWindow | null = null
let hostServer: RunningServer | null = null

// ────────────────────────────────────────────────────────────────────────────
// IPC
// ────────────────────────────────────────────────────────────────────────────
function registerIpc(): void {
  ipcMain.handle('config:get', () => loadConfig())
  ipcMain.handle('config:set', (_e, patch) => {
    const next = saveConfig(patch)
    // Restart the backend so it picks up the new token / brainWsUrl.
    if (next.token && isValidWsUrl(next.brainWsUrl)) {
      backend.start(next.token, next.brainWsUrl)
    }
    return next
  })
  ipcMain.handle('backend:status', () => backend.getStatus())
  ipcMain.handle('backend:restart', () => {
    const cfg = loadConfig()
    if (cfg.token && isValidWsUrl(cfg.brainWsUrl)) {
      backend.start(cfg.token, cfg.brainWsUrl)
    }
    return backend.getStatus()
  })
  ipcMain.handle('logs:show', async () => {
    await shell.openPath(app.getPath('logs'))
  })
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    packaged: app.isPackaged,
    rendererOrigin: isDev ? DEV_RENDERER_URL : hostServer?.url || '',
  }))
}

backend.onStatus((s) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('backend:status', s)
  }
})

// Spawn the backend only when we have a token AND a fully-qualified WS URL.
// Empty token, or a relative/garbage brainWsUrl (e.g. "/ws/tools") will reach
// here on first run or after a malformed disk load — skip silently and let
// the UI surface "not configured" via the empty config.
function tryStartBackend(): void {
  const cfg = loadConfig()
  console.log(`[main] tryStartBackend: token=${cfg.token ? 'present' : 'EMPTY'} brainWsUrl=${cfg.brainWsUrl}`)
  if (cfg.token && isValidWsUrl(cfg.brainWsUrl)) {
    console.log('[main] tryStartBackend: calling backend.start()')
    backend.start(cfg.token, cfg.brainWsUrl)
  } else {
    console.log('[main] tryStartBackend: skipping — config not valid')
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Window
// ────────────────────────────────────────────────────────────────────────────
async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 620,
    title: 'Dragsa',
    // Custom window/taskbar icon — surfaces the brand in the alt-tab switcher
    // and Linux/Windows taskbar. macOS title bars don't show window icons;
    // the Dock icon is overridden separately in `bootstrap()`.
    icon: join(__dirname, '..', 'build', 'icon.png'),
    backgroundColor: '#f8fafc',
    show: false,
    // Menu bar is always visible (set by installAppMenu() in bootstrap).
    // Removing autoHideMenuBar makes the in-window menu visible by default
    // on Windows/Linux; on macOS the menu lives in the system menu bar
    // regardless of this flag.
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload uses Node 'net' indirectly via fetch in main; sandbox would break contextBridge in some cases
      spellcheck: false,
    },
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // Open external links in the OS browser, never in-app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev) {
    await mainWindow.loadURL(DEV_RENDERER_URL)
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    if (!hostServer) throw new Error('host server not started')
    await mainWindow.loadURL(hostServer.url)
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Lifecycle
// ────────────────────────────────────────────────────────────────────────────
async function bootstrap(): Promise<void> {
  registerIpc()
  installAppMenu()

  // In dev mode `electron .` runs from the source tree, so the binary carries
  // the default Electron icon — not our brand logo. Override the Dock icon at
  // runtime. Skipped in packaged builds: `build/` is not packaged (only the
  // generated `.icns` lands inside Contents/Resources), and `app.dock.setIcon`
  // with a missing path returns an empty NativeImage which can throw on
  // recent Electron, killing bootstrap and closing the app silently.
  if (process.platform === 'darwin' && app.dock && !app.isPackaged) {
    app.dock.setIcon(join(__dirname, '..', 'build', 'icon.png'))
  }

  if (!isDev) {
    // In prod we serve the built UI from a local-only HTTP server.
    const rendererDir = join(__dirname, 'renderer')
    hostServer = await startHostServer(rendererDir)
  }

  // Spawn the backend with whatever config we have. If config is empty or the
  // brainWsUrl is malformed (e.g. "/ws/tools"), the backend sits idle until the
  // user configures it via the UI.
  tryStartBackend()

  await createWindow()

  // Auto-update: only in packaged builds. Dev runs from source, so the
  // app-update.yml baked into the installer is absent and the updater would
  // 404 against GitHub. The check downloads in the background and surfaces a
  // native OS notification when the new bundle is ready to swap in on quit.
  if (!isDev) {
    autoUpdater.checkForUpdatesAndNotify().catch((err: unknown) => {
      console.error('[main] auto-update check failed:', err)
    })
  }
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

app.whenReady().then(bootstrap).catch((err) => {
  console.error('[main] bootstrap failed:', err)
  // Surface the failure to the user instead of dying silently. showErrorBox
  // is safe to call before whenReady (Electron documents this exception).
  try {
    dialog.showErrorBox(
      'Dragsa failed to start',
      err instanceof Error ? (err.stack || err.message) : String(err),
    )
  } catch {
    /* ignore — showErrorBox can theoretically fail if no window server */
  }
  app.quit()
})

app.on('window-all-closed', () => {
  // macOS convention: keep app alive in dock. Everywhere else: quit.
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow().catch((err) => console.error('[main] re-create window failed:', err))
  }
})

app.on('before-quit', async () => {
  backend.stop()
  if (hostServer) {
    try {
      await hostServer.close()
    } catch {
      /* ignore */
    }
  }
})
