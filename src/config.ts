// Persistent Electron-side config. Lives in userData so it survives app
// updates and is OS-appropriate (Application Support on macOS).
//
// This is the SOURCE OF TRUTH for brainUrl/token at the desktop-app level.
// The UI's localStorage settings stay in sync via the preload bridge but
// are not authoritative — the brain never sees them.

import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type DragsaConfig = {
  /** Brain HTTP base, e.g. "http://127.0.0.1:8080". Empty = unconfigured. */
  brainUrl: string
  /** Brain WS URL the tools binary dials out to. Defaults derived from brainUrl. */
  brainWsUrl: string
  /** Shared bearer token. Must match the brain's DRAGSA_TOKEN. */
  token: string
}

const DEFAULTS: DragsaConfig = {
  brainUrl: '',
  brainWsUrl: '',
  token: '',
}

let cache: DragsaConfig | null = null
let configPath: string | null = null

function path(): string {
  if (configPath) return configPath
  configPath = join(app.getPath('userData'), 'settings.json')
  return configPath
}

/**
 * True iff `url` parses as ws(s)://... with a hostname. Anything else
 * (`"/ws/tools"`, `"localhost:8080"`, empty) is rejected so we never hand a
 * bad value to the spawned backend or persist one to disk.
 */
export function isValidWsUrl(url: string): boolean {
  if (!url) return false
  try {
    const u = new URL(url)
    return (u.protocol === 'ws:' || u.protocol === 'wss:') && !!u.hostname
  } catch {
    return false
  }
}

/** True iff `url` parses as http(s)://host... — the only shape we accept as a brain URL. */
function isValidHttpUrl(url: string): boolean {
  if (!url) return false
  try {
    const u = new URL(url)
    return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname
  } catch {
    return false
  }
}

/** Strip a malformed brainUrl/brainWsUrl that snuck in from disk or a partial save.
 *  Invariant: brainUrl valid ⇔ brainWsUrl valid. Both empty is OK. */
function sanitize(c: DragsaConfig): DragsaConfig {
  if (c.brainUrl && !isValidHttpUrl(c.brainUrl)) {
    console.warn(`[config] dropping invalid brainUrl: ${c.brainUrl}`)
    c.brainUrl = ''
    c.brainWsUrl = ''
  }
  if (c.brainWsUrl && !isValidWsUrl(c.brainWsUrl)) {
    console.warn(`[config] dropping invalid brainWsUrl: ${c.brainWsUrl}`)
    c.brainWsUrl = ''
  }
  if (!c.brainUrl && c.brainWsUrl) {
    // brainWsUrl is meaningless without a brainUrl — keep them consistent.
    c.brainWsUrl = ''
  }
  return c
}

export function loadConfig(): DragsaConfig {
  if (cache) return cache
  const p = path()
  let next: DragsaConfig
  try {
    if (!existsSync(p)) {
      next = { ...DEFAULTS }
    } else {
      const raw = readFileSync(p, 'utf-8')
      const parsed = JSON.parse(raw)
      next = sanitize({ ...DEFAULTS, ...parsed })
    }
  } catch (err) {
    console.error(`[config] failed to read ${p}: ${err}; using defaults`)
    next = { ...DEFAULTS }
  }
  cache = next
  return next
}

export function saveConfig(next: Partial<DragsaConfig>): DragsaConfig {
  const merged: DragsaConfig = {
    ...loadConfig(),
    ...next,
  }
  // Auto-derive brainWsUrl if the user set brainUrl to something concrete
  // and didn't pass brainWsUrl explicitly. Only derive when brainUrl itself
  // is a valid http(s) URL — otherwise we'd persist something like
  // "127.0.0.1:8080/ws/tools" that the spawned backend can't dial.
  if (next.brainUrl && next.brainWsUrl === undefined && isValidHttpUrl(next.brainUrl)) {
    merged.brainWsUrl = httpToWs(next.brainUrl) + '/ws/tools'
  }
  // Sanitize AFTER derivation so a derived bad value is also caught and
  // cleared before we write to disk.
  sanitize(merged)
  const p = path()
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(merged, null, 2), 'utf-8')
  cache = merged
  return merged
}

function httpToWs(httpUrl: string): string {
  return httpUrl.replace(/^http/, 'ws').replace(/\/$/, '')
}

/** For tests / dev: reset in-memory cache so a re-read happens. */
export function _resetForTests(): void {
  cache = null
  configPath = null
}
