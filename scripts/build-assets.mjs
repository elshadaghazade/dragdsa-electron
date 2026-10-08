// Copies the built Vite UI into the Electron app's dist/renderer/ so
// electron-builder packages it as part of Contents/Resources/app.
//
// The MCP binary is copied by build-backend.mjs (which runs PyInstaller
// and immediately copies dist/MCP → resources/MCP), so this script is
// strictly UI-copying — kept as a separate step so the build pipeline
// stays linear (tsc → pyinstaller → assets → electron-builder).
//
// Run automatically by `npm run build`.

import { existsSync, mkdirSync, cpSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')                       // dragsa-electron/
const repo = resolve(root, '..')                             // dragsa/
const uiDist = join(repo, 'dragsa-ui', 'dist')
const rendererOut = join(root, 'dist', 'renderer')

function die(msg) {
  console.error(`\n✗ ${msg}\n`)
  process.exit(1)
}

if (!existsSync(join(uiDist, 'index.html'))) {
  die(`Missing ${uiDist}/index.html — run "npm run build" in dragsa-ui/ first.`)
}
mkdirSync(dirname(rendererOut), { recursive: true })
cpSync(uiDist, rendererOut, { recursive: true })
console.log(`✓ renderer: ${uiDist} → ${rendererOut}`)