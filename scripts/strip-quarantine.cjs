#!/usr/bin/env node
/**
 * Make Electron launchable on macOS 26.x.
 *
 * Background: macOS 26.x (Tahoe) XProtect scans unsigned Electron binaries
 * and silently deletes Electron.app from the project's node_modules. The
 * deletion can happen minutes after npm install — stripping quarantine
 * xattrs alone is not durable. The only reliable workaround is to keep
 * restoring Electron.app right before we launch it.
 *
 * What this script does, in order:
 *   1. If node_modules/electron/dist/Electron.app is missing, run the
 *      electron package's own install.js (idempotent — reuses npm cache,
 *      no network if cache is warm). Cheap when present, ~10s on cold.
 *   2. Strip com.apple.quarantine and com.apple.provenance recursively
 *      from the freshly-restored bundle, plus any pre-built bundles
 *      under release/.
 *   3. Never fails the hook — exits 0 even if everything above bails.
 *
 * Runs as postinstall (after npm install), predev (before npm run dev),
 * and prestart (before npm start).
 */
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const ATTRS = ['com.apple.quarantine', 'com.apple.provenance'];

function rel(p) {
  return path.relative(root, p);
}

function log(msg) {
  console.log(`[strip-quarantine] ${msg}`);
}

function ensureElectronApp() {
  const electronApp = path.join(root, 'node_modules', 'electron', 'dist', 'Electron.app');
  if (fs.existsSync(electronApp)) return;

  const installScript = path.join(root, 'node_modules', 'electron', 'install.js');
  if (!fs.existsSync(installScript)) {
    log(`electron package not installed yet — skipping restore`);
    return;
  }

  log(`Electron.app missing — re-running electron/install.js`);
  const result = spawnSync(process.execPath, [installScript], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    log(`electron/install.js exited ${result.status} — will let electron surface the error`);
  }
}

function stripAttrs(target) {
  for (const attr of ATTRS) {
    try {
      execFileSync('xattr', ['-dr', attr, target], { stdio: 'ignore' });
    } catch {
      // xattr returns non-zero when the attr isn't set on any file in the
      // tree. That's expected on a brand-new extract — ignore.
    }
  }
}

function stripAll() {
  const candidates = [
    path.join(root, 'node_modules', 'electron', 'dist', 'Electron.app'),
    path.join(root, 'node_modules', 'electron', 'dist', 'Electron Helper.app'),
    path.join(root, 'release', 'mac-arm64', 'Dragsa.app'),
    path.join(root, 'release', 'mac', 'Dragsa.app'),
  ];
  let touched = 0;
  for (const c of candidates) {
    if (!fs.existsSync(c)) continue;
    stripAttrs(c);
    touched += 1;
    log(`stripped ${c.includes('Electron.app') && c.includes('node_modules') ? 'Electron.app' : rel(c)}`);
  }
  return touched;
}

ensureElectronApp();
const n = stripAll();
if (n === 0) {
  log(`nothing to strip (Electron.app not present and no release bundles found)`);
} else {
  log(`done — ${n} bundle(s) cleared`);
}