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
    // No exceptions: the mobile gate is blind to nothing. Expo 58 closed all six it used to carry.
    // Four went when the SDK dropped the packages — `zod` and `deepmerge` (@expo/cli replaced zod
    // with @expo/schema-utils; @expo/config no longer merges with deepmerge) and both `image-size`
    // advisories (@expo/metro's metro@0.87 has no image-size dependency). The other two, `glob`
    // (GHSA-3g3m-2fjr-6pw4) and `minimatch` (GHSA-g3hv-75wg-m249), survived the upgrade —
    // @expo/cli and @expo/fingerprint still ask for glob ^13 / minimatch ^10 — and are closed by
    // the `glob` and `minimatch` entries in mobile/package.json's `overrides` instead. Those
    // overrides are permanent, not a staging post: @expo/fingerprint is not SDK-versioned
    // (expo@58 pulls it as ^0.21.9), so a patch install could otherwise reintroduce glob@13 with
    // no SDK bump to notice.
    allowed: new Map(),
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
    // Fail closed on a severity this gate does not recognise. Defaulting an absent or unknown
    // `severity` to 0 ranked it below every floor, including mobile's `low`, so npm inventing a
    // new severity name — or omitting the field — would silently demote the advisory to the
    // reported-only list where it could never fail the gate. `critical` is the safe default: a
    // severity we cannot rank is treated as the worst, so it surfaces as unexpected and has to be
    // reasoned about before it can pass.
    if ((SEVERITY_RANK[item.severity] ?? SEVERITY_RANK.critical) < floor) {
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
