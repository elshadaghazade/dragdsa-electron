// Cross-platform application menu — minimal: just "About Dragsa".
//
// The app is a single-purpose research agent; the menubar is treated as
// visual noise and intentionally contains nothing but a single About entry.
// Keyboard shortcuts (Cmd+C/V, Cmd+Q) still work even without an Edit
// menu, so the reduced surface doesn't block normal form interaction.
//
// Defining an explicit menu replaces Electron's default one, which would
// otherwise re-add File/Edit/View/Window on macOS.

import { app, Menu, type MenuItemConstructorOptions, dialog } from 'electron'

function showAbout(): void {
  dialog.showMessageBox({
    type: 'info',
    title: `About ${app.name}`,
    message: app.name,
    detail: [
      'An autonomous B2B research agent that maps decision-makers for any company or market — names, titles, work emails, direct phones, and LinkedIn profiles.',
      '',
      'This desktop client packages the local tools engine (browser automation, search, archive lookups) and connects to your Dragsa brain over WebSocket.',
      '',
      '• Company & contact research',
      '• Market discovery by region and category',
      '• Saved markets with filters and CSV export',
      '• Background jobs with live progress streaming',
      '',
      `Version ${app.getVersion()}`,
    ].join('\n'),
    buttons: ['OK'],
  })
}

export function installAppMenu(): void {
  const isMac = process.platform === 'darwin'
  const appName = app.name

  const aboutItem: MenuItemConstructorOptions = {
    label: `About ${appName}`,
    click: () => showAbout(),
  }

  // macOS: the system renders the app menu (Dragsa > …). We provide only
  // About + Quit (Quit is added explicitly so it's positioned predictably
  // below the About entry rather than wherever the system wants it).
  // Windows / Linux: a single Help menu holds About.
  const template: MenuItemConstructorOptions[] = isMac
    ? [
        {
          label: appName,
          submenu: [aboutItem, { type: 'separator' }, { role: 'quit' }],
        },
      ]
    : [{ role: 'help', submenu: [aboutItem] }]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}