// Builds the tools MCP server binary (tools_server.py → dist/MCP via
// PyInstaller) and copies it into resources/MCP so the Electron app
// has a self-contained copy that ships with the package.
//
// Run automatically by `npm run dev` and `npm run build`. No need to
// invoke pyinstaller by hand.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, cpSync, chmodSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')                       // dragsa-electron/
const repo = resolve(root, '..')                             // dragsa/

function die(msg) {
  console.error(`\n✗ ${msg}\n`)
  process.exit(1)
}

// Resolve how to invoke pyinstaller:
//   1. .venv/bin/pyinstaller (the conventional dev-dep install path)
//   2. `pyinstaller` on PATH (operator-installed system copy)
//   3. `uv run --with pyinstaller -- pyinstaller` — ephemeral install via
//      the project's existing uv toolchain, so the build works on a fresh
//      checkout without needing a separate `pip install pyinstaller` step.
const venvPyinstaller = join(repo, '.venv', 'bin', 'pyinstaller')
let pyinstallerCmd
let pyinstallerArgs
if (existsSync(venvPyinstaller)) {
  pyinstallerCmd = venvPyinstaller
  pyinstallerArgs = ['MCP.spec']
} else {
  pyinstallerCmd = 'uv'
  pyinstallerArgs = [
    'run', '--with', 'pyinstaller', '--', 'pyinstaller', 'MCP.spec',
  ]
}

console.log(
  `▶ running ${pyinstallerCmd} ${pyinstallerArgs.join(' ')} (cwd=${repo})`,
)
const result = spawnSync(pyinstallerCmd, pyinstallerArgs, {
  cwd: repo,
  stdio: 'inherit',
})
if (result.status !== 0) {
  die(`pyinstaller exited with status ${result.status}`)
}

const src = join(repo, 'dist', 'MCP')
const dst = join(root, 'resources', 'MCP')
if (!existsSync(src)) {
  die(`expected ${src} after pyinstaller, but it's missing`)
}

mkdirSync(dirname(dst), { recursive: true })
// Overwrite the previous copy so we never ship a stale binary.
cpSync(src, dst)
chmodSync(dst, 0o755)
if (!(statSync(dst).mode & 0o111)) {
  die(`${dst} is not executable after copy`)
}
console.log(`✓ MCP: ${src} → ${dst}`)
