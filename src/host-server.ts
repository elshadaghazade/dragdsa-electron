// Tiny local HTTP server. Two jobs:
//   1. Serve the built Vite UI from dist/renderer/ at /
//   2. Proxy /api/* to the configured brain, transparently forwarding
//      the Authorization header and streaming the response back
//      (so SSE over /api/research/{id}/stream works).
//
// Bound to 127.0.0.1 only — never reachable from the network. The
// BrowserWindow is the only legitimate client.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { loadConfig, type DragsaConfig } from './config'
import { resolveBrainUrl } from './backend'

const HOST = '127.0.0.1'
const PORT = Number(process.env.DRAGSA_ELECTRON_PORT) || 5544

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
}

export type RunningServer = {
  url: string
  port: number
  close: () => Promise<void>
}

export async function startHostServer(rendererDir: string): Promise<RunningServer> {
  if (!existsSync(rendererDir)) {
    throw new Error(`rendererDir not found: ${rendererDir}`)
  }

  const server = createServer((req, res) => handle(req, res, rendererDir))
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(PORT, HOST, () => resolveListen())
  })

  const url = `http://${HOST}:${PORT}`
  console.log(`[host-server] serving ${rendererDir} at ${url}`)

  return {
    url,
    port: PORT,
    close: () =>
      new Promise<void>((res2, rej2) => {
        server.close((err) => (err ? rej2(err) : res2()))
      }),
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Request handling
// ────────────────────────────────────────────────────────────────────────────

async function handle(req: IncomingMessage, res: ServerResponse, rendererDir: string): Promise<void> {
  try {
    const url = new URL(req.url || '/', `http://${HOST}:${PORT}`)
    if (url.pathname.startsWith('/api/')) {
      await proxyApi(req, res)
      return
    }
    serveStatic(req, res, rendererDir, url.pathname)
  } catch (err) {
    console.error('[host-server] error:', err)
    if (!res.headersSent) {
      res.statusCode = 500
      res.setHeader('content-type', 'text/plain')
      res.end(`host-server error: ${(err as Error).message}`)
    } else {
      res.end()
    }
  }
}

function serveStatic(req: IncomingMessage, res: ServerResponse, root: string, pathname: string): void {
  // SPA fallback: any non-asset path that doesn't start with /assets/ serves index.html.
  let rel = pathname === '/' ? '/index.html' : pathname
  const full = normalize(join(root, rel))
  if (!full.startsWith(root)) {
    res.statusCode = 403
    res.end('forbidden')
    return
  }
  if (!existsSync(full) || !statSync(full).isFile()) {
    // SPA fallback for client-side routes.
    const fallback = join(root, 'index.html')
    if (existsSync(fallback)) {
      streamFile(res, fallback)
      return
    }
    res.statusCode = 404
    res.end('not found')
    return
  }
  streamFile(res, full)
}

function streamFile(res: ServerResponse, file: string): void {
  const mime = MIME[extname(file).toLowerCase()] || 'application/octet-stream'
  res.statusCode = 200
  res.setHeader('content-type', mime)
  res.setHeader('cache-control', 'no-cache')
  createReadStream(file).pipe(res)
}

// ────────────────────────────────────────────────────────────────────────────
// /api/* proxy
// ────────────────────────────────────────────────────────────────────────────

async function proxyApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cfg = loadConfig()
  const brainUrl = resolveBrainUrl(cfg.brainUrl)
  if (!brainUrl) {
    res.statusCode = 503
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ error: 'brain not configured', hint: 'open Settings and set brainUrl + token' }))
    return
  }
  if (!cfg.token) {
    res.statusCode = 503
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ error: 'token not configured' }))
    return
  }

  const target = buildTarget(cfg, req.url || '/')
  const method = (req.method || 'GET').toUpperCase()
  const headers = filterRequestHeaders(req, cfg)

  const init: RequestInit = { method, headers }
  if (method !== 'GET' && method !== 'HEAD') {
    // Buffer the request body — payloads here are tiny (JSON), and buffering
    // sidesteps the cross-version `duplex: 'half'` quirk when passing a
    // Node stream directly to fetch().
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    init.body = Buffer.concat(chunks)
  }

  try {
    const upstream = await fetch(target, init)
    res.statusCode = upstream.status
    // Forward response headers, but strip hop-by-hop ones + content-encoding
    // (Node will decode if we don't, which would corrupt SSE).
    upstream.headers.forEach((value, key) => {
      const k = key.toLowerCase()
      if (k === 'content-encoding' || k === 'transfer-encoding' || k === 'connection') return
      res.setHeader(key, value)
    })

    if (!upstream.body) {
      res.end()
      return
    }
    // Stream the body back to the renderer. For SSE this is exactly what
    // we want — chunks flow through as they arrive.
    const reader = upstream.body.getReader()
    const pump = async () => {
      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          res.end()
          return
        }
        if (!res.write(Buffer.from(value))) {
          await new Promise<void>((r) => res.once('drain', r))
        }
      }
    }
    await pump()
  } catch (err) {
    console.error('[host-server] proxy error:', err)
    if (!res.headersSent) {
      res.statusCode = 502
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ error: `brain unreachable: ${(err as Error).message}` }))
    } else {
      res.end()
    }
  }
}

function buildTarget(cfg: DragsaConfig, reqPath: string): string {
  // host-server.ts's job is to translate the renderer's /api/* into the
  // brain's actual paths. The renderer doesn't know about nginx's /brain
  // prefix — that's why we apply resolveBrainUrl() at the seam. After
  // resolution, `base` is the brain HTTP origin (e.g.
  // `https://dragsa.elshadaghayev.com/brain`), and the prefix-stripped path
  // appends directly to it.
  const base = resolveBrainUrl(cfg.brainUrl)!.replace(/\/$/, '')
  const stripped = reqPath.replace(/^\/api/, '')
  return `${base}${stripped || '/'}`
}

function filterRequestHeaders(req: IncomingMessage, cfg: DragsaConfig): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue
    const key = k.toLowerCase()
    if (
      key === 'host' ||
      key === 'connection' ||
      key === 'content-length' ||
      key === 'transfer-encoding' ||
      key === 'accept-encoding' ||
      key === 'authorization' // we override below
    ) {
      continue
    }
    out[key] = Array.isArray(v) ? v.join(', ') : v
  }
  out['authorization'] = `Bearer ${cfg.token}`
  return out
}
