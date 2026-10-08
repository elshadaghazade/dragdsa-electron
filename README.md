# dragsa-electron

Electron wrapper for dragsa. Bundles the Vite/React UI (`../dragsa-ui`) and the
compiled tools backend binary (`../dist/backend`) into a single desktop app.

```
┌──────────────────────────────────────────────────────────────────┐
│  dragsa.app                                                      │
│  ┌──────────────────────┐    ┌────────────────────────────────┐  │
│  │ BrowserWindow        │    │ host-server (Node http)        │  │
│  │  loads http://       │◄──►│  127.0.0.1:5544                │  │
│  │  127.0.0.1:5544      │    │  serves dist/renderer/         │  │
│  │                      │    │  proxies /api/* → brain        │  │
│  └──────────────────────┘    └────────────────────────────────┘  │
│           ▲                              ▲                       │
│           │ IPC                          │ Bearer token           │
│  ┌────────┴───────────┐                  │                       │
│  │ preload (bridge)   │         ┌────────┴──────────┐             │
│  │ + main process     │  spawn  │ resources/backend │             │
│  │ reads userData/    │────────►│ (compiled tools_  │             │
│  │ settings.json      │         │  server.py)       │───ws──► brain│
│  └────────────────────┘         └───────────────────┘             │
└──────────────────────────────────────────────────────────────────┘
```

## Layout

```
dragsa-electron/
├── src/
│   ├── main.ts         # Electron main process
│   ├── preload.ts      # contextBridge — exposes window.dragsa
│   ├── host-server.ts  # tiny Node http server for prod (static + /api proxy)
│   ├── backend.ts      # spawns/kills the tools binary
│   └── config.ts       # userData/settings.json loader
├── scripts/
│   └── build-assets.mjs   # copies renderer + binary into dist/
├── build/
│   └── entitlements.mac.plist
├── package.json
├── tsconfig.json
└── .gitignore
```

## Dev workflow

You need three terminals (or use `&` in one):

```bash
# 1. Brain — wherever you want it (local laptop, VPS, etc.)
cd ../                # repo root
uv run brain.py --host 127.0.0.1 --port 8080

# 2. UI dev server (existing)
cd ../dragsa-ui
npm run dev           # Vite on http://localhost:5173

# 3. Electron in dev mode (this folder)
npm run dev           # compiles main+preload, then `electron .`
```

In dev mode the BrowserWindow loads `http://localhost:5173` directly — your
existing Vite dev server. The Electron app only spawns the tools backend binary
and manages its lifecycle. CORS / auth all behave as in dev today.

## Prod build

```bash
# 1. Build the UI (one-off)
cd ../dragsa-ui
npm run build         # produces ../dragsa-ui/dist/

# 2. Make sure the backend binary exists
cd ..
pyinstaller backend.spec   # produces ../dist/backend

# 3. Build + package the Electron app
cd dragsa-electron
npm run dist:mac      # → release/Dragsa-0.1.0-arm64.dmg + .zip
```

`npm run build` inside `dragsa-electron/` does three things:
1. `tsc` → compiles `src/*.ts` → `dist/*.js`
2. `scripts/build-assets.mjs` → copies `dragsa-ui/dist/` → `dist/renderer/` and
   `dist/backend` → `resources/backend`
3. `electron-builder` (only in `dist:mac`) → packages everything into a `.app`
   and `.dmg`, with the backend placed in `Contents/Resources/backend` (via
   `extraResources`).

In prod the BrowserWindow loads `http://127.0.0.1:5544` — the host server inside
the main process serves the built UI and proxies `/api/*` to the brain. The
brain's HTTP CORS is irrelevant because the renderer never talks to it directly.

## Config

Stored in `app.getPath('userData')/settings.json`:

- macOS: `~/Library/Application Support/Dragsa/settings.json`
- Linux: `~/.config/Dragsa/settings.json`
- Windows: `%APPDATA%/Dragsa/settings.json`

Shape:

```json
{
  "brainUrl":   "http://127.0.0.1:8080",
  "brainWsUrl": "ws://127.0.0.1:8080/ws/tools",
  "token":      "<shared with brain's DRAGSA_TOKEN>"
}
```

The first time the UI tries to call `/api/*` with no config set, the host server
returns `503 { error: "brain not configured" }`. The UI should detect this and
prompt for brain URL + token, then call `window.dragsa.setConfig(...)` — which
persists to disk and restarts the backend with the new env vars.

## Notes

- The backend binary is NOT packaged inside `app.asar`. It lives under
  `Contents/Resources/backend` (via `extraResources`) so the OS can execute it
  directly without an asar extraction step.
- Single-instance lock is enabled — launching the app twice focuses the
  existing window instead of spawning a second backend.
- The host server binds `127.0.0.1` only. It is not reachable from the
  network even if the user is on a public network.
- Logs are written to `app.getPath('logs')`. The preload exposes `showLogs()`
  to open that folder.
