// scripts/ensure-release-published.mjs
//
// `git push --follow-tags` makes GitHub auto-create a draft release for the
// pushed tag. electron-builder's publish step then collides with that
// draft: its GET /releases/tags/:tag check returns "not found" (the
// GitHub provider doesn't reliably see drafts), then POST /releases
// returns 422 `tag_name already_exists` and the publish aborts mid-upload
// with only some assets landed. To make `dist:*` work end-to-end without
// manual intervention, we drop any pre-existing release for the current
// version's tag before electron-builder runs. electron-builder then
// creates a fresh release with the right assets.
//
// Safe in this project's flow because releases are always created empty
// by `git push --follow-tags` (draft) and filled by electron-builder —
// there are no hand-curated release notes to lose. If a previous `dist:*`
// run already published assets, deleting the release is destructive, but
// the alternative is the 422 collision that started this whole thread.

import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const tag = `v${pkg.version}`

try {
  execSync(`gh release view "${tag}" --json databaseId,assets`, { stdio: ['ignore', 'pipe', 'pipe'] })
} catch {
  console.log(`[pre-dist] no release for ${tag} — electron-builder will create it.`)
  process.exit(0)
}

console.log(`[pre-dist] dropping existing release ${tag} so electron-builder can recreate it cleanly.`)
execSync(`gh release delete "${tag}" --yes`, { stdio: 'inherit' })
console.log(`[pre-dist] ${tag} cleared.`)
