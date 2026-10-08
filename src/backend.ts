// Spawns / kills the compiled tools_server.py binary as an invisible child
// process. Respawns automatically when config changes.
//
// tools_server.py accepts `--brain-url <wss://...>` (also reads BRAIN_WS_URL
// from env as a fallback). We pass it as a CLI arg so the value is visible
// in `ps` while debugging, and so the spawned process is decoupled from any
// shell-level env-var leakage.
//
// DRAGSA_TOKEN is still passed via env (it's a secret, so it should never
// appear in argv).

import { spawn, type ChildProcess } from 'node:child_process'
import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { isValidWsUrl } from './config'

// Implicit prod brain — Cloudflare-tunneled public URL. Used when the user
// has no saved config and no BRAIN_WS_URL override (the typical fresh-
// install first-launch case in the packaged app). Goes through nginx's
// `/brain/` location, which strips the `/brain` prefix before forwarding to
// the brain's actual `/healthz` / `/research` / `/ws/tools` routes — see
// infra/nginx/nginx.prod.conf.
const DEFAULT_PROD_BRAIN_URL = 'https://dragsa.elshadaghayev.com/brain'
const DEFAULT_PROD_BRAIN_WS_URL = 'wss://dragsa.elshadaghayev.com/brain/ws/tools'

/**
 * Resolve the brain WS URL the tools binary should dial, with this precedence:
 *
 *   1. `BRAIN_WS_URL` env var (set in the launcher's shell — dev escape hatch
 *      for pointing at a local brain without touching saved settings)
 *   2. Saved config from `loadConfig()` (the user can override via the
 *      Settings UI in the renderer)
 *   3. `DEFAULT_PROD_BRAIN_WS_URL` (implicit prod fallback — packaged builds
 *      "just work" against the public Cloudflare-tunneled brain)
 *
 * `null` means "no value, give up" — only the three sources above count.
 */
export function resolveBrainWsUrl(savedUrl: string): string | null {
  const fromEnv = process.env.BRAIN_WS_URL?.trim()
  if (fromEnv) return fromEnv
  const fromConfig = savedUrl?.trim()
  if (fromConfig) return fromConfig
  if (DEFAULT_PROD_BRAIN_WS_URL) return DEFAULT_PROD_BRAIN_WS_URL
  return null
}

/**
 * HTTP counterpart of `resolveBrainWsUrl`. Used by host-server.ts when the
 * renderer hits `/api/*` and we need to translate it to the brain's actual
 * URL. Same precedence; `BRAIN_HTTP_URL` is the env-var override so dev can
 * point at a local brain without going through the public hostname.
 */
export function resolveBrainUrl(savedUrl: string): string | null {
  const fromEnv = process.env.BRAIN_HTTP_URL?.trim()
  if (fromEnv) return fromEnv
  const fromConfig = savedUrl?.trim()
  if (fromConfig) return fromConfig
  if (DEFAULT_PROD_BRAIN_URL) return DEFAULT_PROD_BRAIN_URL
  return null
}

export type BackendStatus = {
  running: boolean
  pid?: number
  lastError?: string
  binaryPath?: string
}

let proc: ChildProcess | null = null
let lastError: string | undefined

function resolveBinary(): string {
  // Canonical location: resources/MCP inside the Electron app.
  // - In dev, `npm run dev` runs `build:backend` first which produces this.
  // - In production, electron-builder copies it to Contents/Resources/MCP
  //   via the `extraResources` config in package.json, and process.resourcesPath
  //   points there.
  const packaged = join(process.resourcesPath, 'MCP')
  if (app.isPackaged) return packaged
  const devCanonical = join(app.getAppPath(), 'resources', 'MCP')
  if (existsSync(devCanonical)) return devCanonical
  // Last-resort fallback: the raw PyInstaller output at the repo root. Lets
  // a developer run from a checkout where resources/MCP was deleted but
  // dist/MCP still exists. `npm run dev` always rebuilds the canonical
  // location, so this branch should only fire if someone nuked it by hand.
  return join(app.getAppPath(), '..', 'dist', 'MCP')
}

export function getStatus(): BackendStatus {
  const bin = resolveBinary()
  return {
    running: !!proc && proc.exitCode === null,
    pid: proc?.pid,
    lastError,
    binaryPath: bin,
  }
}

export type StatusListener = (s: BackendStatus) => void
const listeners = new Set<StatusListener>()
export function onStatus(fn: StatusListener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
function emit(): void {
  const s = getStatus()
  for (const fn of listeners) fn(s)
}

export function start(token: string, brainWsUrl: string): void {
  const bin = resolveBinary()
  console.log(`[MCP] start called; bin=${bin} token=${token ? 'present' : 'EMPTY'} brainWsUrl=${brainWsUrl}`)
  if (!existsSync(bin)) {
    console.log(`[MCP] REJECT: binary not found at ${bin}`)
    lastError = `MCP binary not found at ${bin}.`
    emit()
    return
  }
  if (!token) {
    console.log('[MCP] REJECT: empty token')
    lastError = 'DRAGSA_TOKEN is empty — configure the token in Settings first.'
    emit()
    return
  }

  // Resolve the actual URL (env override → saved config → prod default) and
  // validate the resolved value, not the raw input. The raw `brainWsUrl` may
  // be empty (first run) and that's fine — the prod default takes over.
  const resolvedBrainWsUrl = resolveBrainWsUrl(brainWsUrl)
  console.log(`[MCP] resolved brainWsUrl: env=${process.env.BRAIN_WS_URL ? 'set' : 'unset'} config=${JSON.stringify(brainWsUrl)} → ${resolvedBrainWsUrl}`)
  if (!resolvedBrainWsUrl) {
    console.log('[MCP] REJECT: no brain URL resolvable')
    lastError = 'BRAIN_WS_URL is empty — configure the brain URL in Settings first.'
    emit()
    return
  }
  if (!isValidWsUrl(resolvedBrainWsUrl)) {
    console.log(`[MCP] REJECT: invalid brainWsUrl: ${resolvedBrainWsUrl}`)
    lastError = `BRAIN_WS_URL is malformed: ${resolvedBrainWsUrl}. Open Settings and re-enter the brain URL.`
    emit()
    return
  }

  console.log(`[MCP] spawning ${bin} --brain-url ${resolvedBrainWsUrl}`)
  stop() // idempotent restart

  lastError = undefined
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DRAGSA_TOKEN: token,
  }

  const child = spawn(bin, ['--brain-url', resolvedBrainWsUrl], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  proc = child

  const tag = `[MCP ${child.pid}]`
  child.stdout?.on('data', (d) => process.stdout.write(`${tag} ${d}`))
  child.stderr?.on('data', (d) => {
    const s = d.toString()
    process.stderr.write(`${tag} ${s}`)
    if (!lastError) lastError = s.split('\n')[0]
  })
  child.on('exit', (code, signal) => {
    process.stdout.write(`${tag} exited code=${code} signal=${signal}\n`)
    if (code && code !== 0) {
      lastError = `MCP exited with code ${code}.`
    }
    if (proc === child) proc = null
    emit()
  })

  emit()
}

export function stop(): void {
  if (!proc) return
  try {
    proc.kill('SIGTERM')
  } catch {
    /* ignore */
  }
  // Hard kill after 2s if still alive.
  const p = proc
  setTimeout(() => {
    if (p.exitCode === null) {
      try {
        p.kill('SIGKILL')
      } catch {
        /* ignore */
      }
    }
  }, 2000)
  proc = null
}
