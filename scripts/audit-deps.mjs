import { spawnSync } from 'node:child_process'

// One audit gate for every workspace that needs an exception, so the root and mobile gates cannot
// drift apart. Narrow, temporary allowlists: every entry names the package it was reasoned about,
// so an advisory id cannot silently start covering a different dependency later; everything else
// still fails.
//
// `minSeverity` preserves each scope's historical gate. Root was `npm audit --audit-level=moderate`,
// so a `low` advisory there is reported but not fatal. The mobile gate has always failed on any
// advisory, so it keeps a floor of `low`. The ui gate needs no exceptions and stays a plain
// `npm audit --audit-level=moderate` in CI.

const SEVERITY_RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 }

const SCOPES = {
  root: {
    prefix: null,
    minSeverity: 'moderate',
    allowed: new Map([
      // Every copy of minimatch in the tree comes from electron-builder, a devDependency used only
      // to package the app. The fix is minimatch >= 11.0.1, whose CommonJS export is an object
      // rather than a callable function, and four consumers still call the default export as a
      // function: glob@7 and @electron/asar@3 (asar packing), dir-compare@4 (under
      // @electron/universal@2) and filelist@1 (via jake/ejs). Forcing v11 crashes them — verified
      // directly: glob@7 throws a TypeError mid-walk with minimatch@11 installed. Upstream cannot
      // be upgraded past it either: app-builder-lib pins @electron/asar and @electron/universal to
      // exact versions, and dir-compare@5 still depends on minimatch ^3. The patterns these tools
      // match are the repository's own globs from electron-builder.yml, never remote input. Remove
      // when the electron-builder chain moves to minimatch >= 11.0.1.
      ['GHSA-g3hv-75wg-m249', { package: 'minimatch', why: 'glob amplification in electron-builder packaging tooling' }],
    ]),
  },
  mobile: {
    prefix: 'mobile',
    minSeverity: 'low',
    allowed: new Map([
      // Expo 56 pulls image-size through Metro, with no patched release as of 2026-08-10. Metro only
      // parses trusted, repository-owned image assets at build time, so this is not reachable from
      // remote input. Remove when Expo/Metro moves to a patched image-size.
      ['GHSA-w3rx-r6r6-pgpr', { package: 'image-size', why: 'ICNS parser infinite loop in Metro build tooling' }],
      ['GHSA-5p2g-fcmc-qvqq', { package: 'image-size', why: 'JXL/HEIF parser infinite loop in Metro build tooling' }],
      // The four entries below are all Expo 56 build tooling, and all four are fixed by the same
      // thing: moving mobile to Expo 58 (expo@58 / expo-updates@58), a major platform upgrade that
      // needs its own task and real device validation. None of these packages is bundled into the
      // shipped app — they run on a developer's machine at build time.
      //
      // @expo/cli depends on zod 3.x; the fix is zod >= 4.6.6, a major the CLI is not written
      // against. This is the only `high` exception here that is not image-size, so it is the first
      // one to retire when Expo 58 lands.
      ['GHSA-mrhx-c7xc-m3w5', { package: 'zod', why: 'memory exhaustion in @expo/cli schema validation at build time' }],
      // @expo/config depends on deepmerge 4.3.1; every release >= 4.2.0 is affected and 4.3.1 is the
      // latest, so no patched release exists to move to.
      ['GHSA-gcqx-w48m-w2h4', { package: 'deepmerge', why: 'prototype poisoning in @expo/config merging of repository-owned app config' }],
      // expo-updates and @expo/fingerprint walk the project with glob@13, which needs glob >= 14.0.2
      // and minimatch >= 11.0.1. Both are majors reached only through Expo 58.
      ['GHSA-3g3m-2fjr-6pw4', { package: 'glob', why: 'AbortSignal bypass in expo-updates/@expo/fingerprint project walking' }],
      ['GHSA-g3hv-75wg-m249', { package: 'minimatch', why: 'glob amplification in expo-updates/@expo/fingerprint project walking' }],
    ]),
  },
}

const scopeName = process.argv[2]
const scope = SCOPES[scopeName]

if (!scope) {
  process.stderr.write(`usage: node scripts/audit-deps.mjs <${Object.keys(SCOPES).join('|')}>\n`)
  process.exit(2)
}

const audit = spawnSync('npm', ['audit', '--json', ...(scope.prefix ? ['--prefix', scope.prefix] : [])], {
  cwd: new URL('..', import.meta.url),
  encoding: 'utf8',
})

let report
try {
  report = JSON.parse(audit.stdout)
} catch {
  process.stderr.write(audit.stderr || audit.stdout || 'npm audit returned no report\n')
  process.exit(audit.status || 1)
}

const floor = SEVERITY_RANK[scope.minSeverity]
const vulnerabilities = Object.values(report.vulnerabilities || {})
const advisories = new Map()
const belowFloor = new Map()
for (const vulnerability of vulnerabilities) {
  for (const item of vulnerability.via || []) {
    if (typeof item !== 'object' || !item.url) continue
    const id = item.url.split('/').pop()
    if ((SEVERITY_RANK[item.severity] ?? 0) < floor) {
      if (!advisories.has(id)) belowFloor.set(id, item)
      continue
    }
    advisories.set(id, item)
    belowFloor.delete(id)
  }
}

const unexpected = [...advisories.entries()].filter(([id]) => !scope.allowed.has(id))
const invalidExceptions = [...advisories.entries()].filter(
  ([id, advisory]) => scope.allowed.has(id) && advisory.name !== scope.allowed.get(id).package,
)

if (unexpected.length || invalidExceptions.length || (vulnerabilities.length && !advisories.size && !belowFloor.size)) {
  process.stderr.write(audit.stdout)
  process.exit(1)
}

if (advisories.size) {
  console.log(`${scopeName} audit passed with ${advisories.size} temporary exception(s) — see scripts/audit-deps.mjs for why each is allowed:`)
  for (const [id] of advisories) console.log(`- ${id} (${scope.allowed.get(id).package}): ${scope.allowed.get(id).why}`)
} else {
  console.log(`${scopeName} audit passed with 0 vulnerabilities at or above ${scope.minSeverity}`)
}

// Informational: an exception whose advisory no longer appears has been fixed upstream and should be
// deleted. Not fatal, so a dependency bump never fails the gate for being too good.
const stale = [...scope.allowed.keys()].filter(id => !advisories.has(id))
if (stale.length) {
  console.log(`\n${stale.length} exception(s) no longer needed — remove from scripts/audit-deps.mjs: ${stale.join(', ')}`)
}

if (belowFloor.size) {
  console.log(`\n${belowFloor.size} advisory/advisories below the ${scope.minSeverity} floor, reported only: ${[...belowFloor.keys()].join(', ')}`)
}
