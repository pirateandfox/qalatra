#!/usr/bin/env node
/**
 * Guards the mobile OTA runtime identifier.
 *
 * mobile/app.json sets `runtimeVersion: { policy: "appVersion" }`, so the OTA
 * runtime identifier an EAS Update is published under *is* the literal app
 * version. An installed binary only accepts a bundle whose runtime identifier
 * matches its own. Reusing one app version across two different native
 * runtimes therefore tells Expo that a bundle is compatible with a binary it is
 * not: the bundle references native modules that binary does not contain, and
 * the app crashes at launch.
 *
 * mobile/runtime-versions.json is the append-only ledger of every identifier
 * this project has minted, the Expo SDK major it was minted for and — from
 * 0.4.0 onwards — a `nativeSignature`: a 12-character hash over the part of the
 * tree that decides whether a bundle and a binary are compatible. See
 * nativeSurfaceOf() below for exactly what goes into it.
 *
 * WHAT THIS SCRIPT CHECKS
 *   1. mobile/app.json still sets `runtimeVersion.policy === "appVersion"`.
 *      That policy is the entire premise of the ledger — it is what makes the
 *      identifier the literal app version. Change it and every entry on record
 *      becomes a claim about something else.
 *   2. mobile/app.json and mobile/package.json agree on `version`.
 *   3. No app version appears twice in `minted`. "Never reuse an identifier"
 *      admits no exception, so a duplicate is always wrong — whether the two
 *      claims differ by SDK major or not.
 *   4. The ledger's LAST entry describes the current tree: same app version,
 *      same Expo SDK major, same native signature. A native change with no
 *      version bump fails here, inside one SDK major as well as across two.
 *   5. With `--base <ref>`: the ledger only ever grew since <ref>. Every key an
 *      entry had at the baseline is still present with the same value, so a new
 *      field on an old entry is fine and editing or deleting a claim is not.
 *      Without `--base` this half is skipped, and the pass line says so.
 *
 * WHAT THE SIGNATURE CANNOT SEE — each of these needs a manual version bump:
 *   - a native package whose name contains neither `expo` nor `react-native`
 *     (the dependency net is a name pattern, not a resolved-binary inspection);
 *   - a change to `overrides` that moves a native package's resolved version;
 *   - the *contents* of the asset files mobile/app.json only names by path;
 *   - anything in mobile/ios or mobile/android, should this project ever stop
 *     being managed-workflow-only.
 * Over-inclusion is not the safe direction either: hashing every dependency
 * would mint a brand-new identifier no installed binary has on every pure-JS
 * bump, which delivers nothing to anyone and says nothing about it. That is the
 * silent non-delivery this repo rejected the `fingerprint` policy for.
 *
 * Nothing here talks to EAS. What it guarantees is only that this repository
 * cannot mint a colliding runtime identifier.
 *
 * Fix when it fails: bump `version` in BOTH mobile/app.json and
 * mobile/package.json, and append
 * { appVersion, expoSdkMajor, nativeSignature } to mobile/runtime-versions.json
 * using the signature this script prints. Never reuse an identifier.
 *
 * Usage: node scripts/check-mobile-runtime.mjs [--base <ref>]
 */

import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const APP_JSON = 'mobile/app.json'
const PKG_JSON = 'mobile/package.json'
const LEDGER = 'mobile/runtime-versions.json'

const SIGNATURE_LENGTH = 12
const SIGNATURE_PATTERN = new RegExp(`^[0-9a-f]{${SIGNATURE_LENGTH}}$`)

// Dependencies whose name matches this carry, or can carry, native code. A broad substring net is
// deliberate: it catches `@expo/*`, `expo-*`, `react-native-*`, `@react-native-community/*`,
// `babel-preset-expo` and any future `@scope/react-native-*` without a list to maintain.
const NATIVE_DEPENDENCY_NAME = /expo|react-native/i

// Pinned exactly, because the React runtime version a binary was built against is part of its
// native contract even though neither name matches the pattern above.
const ALWAYS_NATIVE_DEPENDENCIES = ['react', 'react-dom']

// Names that match NATIVE_DEPENDENCY_NAME but ship no native code. Same shape and spirit as
// SCOPES.*.allowed in scripts/audit-deps.mjs: every entry names why it is allowed, and the list is
// checked for staleness below so it cannot rot into a blind spot.
const JS_ONLY_DEPENDENCIES = new Map([
  [
    'react-native-markdown-display',
    'pure-JS renderer over markdown-it — no native module, no autolinking entry. Including it would ' +
      'mint a new runtime identifier on every patch bump, with no binary anywhere that has it.',
  ],
])

const errors = []

function fail(message, ...detail) {
  errors.push([message, detail])
}

function usage(problem) {
  process.stderr.write(`${problem}\nusage: node scripts/check-mobile-runtime.mjs [--base <ref>]\n`)
  process.exit(2)
}

// ── Arguments ────────────────────────────────────────────────────────────────

let baseRef = null

for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i]
  if (arg === '--base') {
    baseRef = process.argv[++i]
    if (!baseRef) usage('--base needs a git ref')
  } else if (arg.startsWith('--base=')) {
    baseRef = arg.slice('--base='.length)
    if (!baseRef) usage('--base needs a git ref')
  } else {
    usage(`unknown argument ${JSON.stringify(arg)}`)
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function readJson(relPath) {
  try {
    return JSON.parse(readFileSync(join(ROOT, relPath), 'utf8'))
  } catch (err) {
    fail(`CANNOT READ: ${relPath}`, err.message)
    return null
  }
}

// Key order and whitespace must not change the hash, or re-indenting app.json would look like a
// native change. Array order is preserved — it is meaningful in `plugins`.
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function deepEqual(a, b) {
  return canonicalJson(a) === canonicalJson(b)
}

/**
 * The part of the tree that decides whether an OTA bundle and an installed binary are compatible:
 * the native-bearing dependency set, and all of app.json's `expo` object except `version`. `version`
 * must be excluded — it IS the identifier, so including it would make every signature match itself
 * and detect nothing.
 *
 * `devDependencies` and `overrides` are excluded. devDependencies here are `typescript` and
 * `@types/react`, which never reach a binary; `overrides` can move a native package's resolved
 * version, which is a stated blind spot in the header rather than a hashed input, because the
 * overrides in this repo exist to pin JS-only transitive packages and change for audit reasons.
 */
function nativeSurfaceOf(pkgJson, appJson) {
  const declared =
    pkgJson?.dependencies && typeof pkgJson.dependencies === 'object' ? pkgJson.dependencies : {}

  const dependencies = {}
  for (const name of Object.keys(declared)) {
    if (JS_ONLY_DEPENDENCIES.has(name)) continue
    if (NATIVE_DEPENDENCY_NAME.test(name) || ALWAYS_NATIVE_DEPENDENCIES.includes(name)) {
      dependencies[name] = declared[name]
    }
  }

  const app = { ...(appJson?.expo && typeof appJson.expo === 'object' ? appJson.expo : {}) }
  delete app.version

  return { app, dependencies }
}

function signatureOf(surface) {
  return createHash('sha256').update(canonicalJson(surface)).digest('hex').slice(0, SIGNATURE_LENGTH)
}

function git(args) {
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  })
}

// ── Read the three inputs ────────────────────────────────────────────────────

const appJson = readJson(APP_JSON)
const pkgJson = readJson(PKG_JSON)
const ledger = readJson(LEDGER)

const appVersion = appJson?.expo?.version
const pkgVersion = pkgJson?.version

if (appJson && typeof appVersion !== 'string') {
  fail(`MISSING VERSION: ${APP_JSON} has no string "expo"."version"`)
}
if (pkgJson && typeof pkgVersion !== 'string') {
  fail(`MISSING VERSION: ${PKG_JSON} has no string "version"`)
}

// ── The runtimeVersion policy is the premise of everything else ──────────────

if (appJson) {
  const policy = appJson?.expo?.runtimeVersion?.policy
  if (policy !== 'appVersion') {
    fail(
      `RUNTIME POLICY CHANGED: ${APP_JSON} "expo"."runtimeVersion"."policy" is ${JSON.stringify(policy)}, not "appVersion"`,
      `${LEDGER} and this script both read the OTA runtime identifier *as* the app version.`,
      'Under any other policy — "fingerprint", "nativeVersion", or none at all — every entry on',
      'record is a claim about an identifier that no longer exists, and this check is meaningless.',
      'Fix: restore { "policy": "appVersion" }. Moving to another policy is a deliberate decision',
      '     that has to rewrite the ledger and this script together — see plan/EVOLUTION.md for why',
      '     "fingerprint" was rejected for this repo.',
    )
  }
}

// ── The two manifests must agree ─────────────────────────────────────────────

if (typeof appVersion === 'string' && typeof pkgVersion === 'string' && appVersion !== pkgVersion) {
  fail(
    'VERSION MISMATCH between the mobile manifests',
    `${APP_JSON}: ${appVersion}`,
    `${PKG_JSON}: ${pkgVersion}`,
    'Fix: set both to the same version — the OTA runtime identifier comes from app.json,',
    '     and the ledger is keyed on it, so a drifting package.json hides the real identifier.',
  )
}

// ── The current tree's Expo SDK major ────────────────────────────────────────

// Tightened from /(\d+)/, which read a major out of the first integer anywhere in the string and so
// accepted "github:expo/expo#58" or ">=57 <59" as a confident "58". An optional ^/~ and an optional
// leading v, then major.minor with an optional patch and prerelease — anything else is unparseable
// and says so, rather than being guessed at.
const EXPO_RANGE = /^\s*[\^~]?v?(\d+)\.(?:\d+|x|\*)(?:\.(?:\d+|x|\*))?(?:-[0-9A-Za-z.-]+)?\s*$/

const expoRange = pkgJson?.dependencies?.expo
let currentSdkMajor = null

if (typeof expoRange !== 'string') {
  if (pkgJson) fail(`MISSING DEPENDENCY: ${PKG_JSON} has no string "dependencies"."expo"`)
} else {
  const match = expoRange.match(EXPO_RANGE)
  if (!match) {
    fail(
      `UNPARSEABLE EXPO RANGE: ${PKG_JSON} "dependencies"."expo" is ${JSON.stringify(expoRange)}`,
      'Fix: use a single-version range this script can read a major out of, e.g. "^58.0.23" or',
      '     "~58.0.23". A tag, a git URL or a compound range hides which SDK major the tree is on,',
      '     and the runtime identifier depends on knowing it.',
    )
  } else {
    currentSdkMajor = Number(match[1])
  }
}

// ── The native signature of the current tree ─────────────────────────────────

let currentSignature = null

if (appJson && pkgJson) {
  const stale = [...JS_ONLY_DEPENDENCIES.keys()].filter(
    name => !Object.prototype.hasOwnProperty.call(pkgJson?.dependencies ?? {}, name),
  )
  if (stale.length > 0) {
    fail(
      'STALE JS-ONLY ALLOWLIST in scripts/check-mobile-runtime.mjs',
      `no longer in ${PKG_JSON} "dependencies": ${stale.join(', ')}`,
      'Fix: delete the entry from JS_ONLY_DEPENDENCIES. An exception for a dependency that is gone',
      '     is a blind spot waiting for a package of the same name to come back as a native one.',
    )
  }
  currentSignature = signatureOf(nativeSurfaceOf(pkgJson, appJson))
}

// ── The ledger must be a non-empty, well-formed list ─────────────────────────

const minted = ledger?.minted
let entries = null

if (ledger) {
  if (!Array.isArray(minted)) {
    fail(`MALFORMED LEDGER: ${LEDGER} has no "minted" array`)
  } else if (minted.length === 0) {
    fail(
      `EMPTY LEDGER: ${LEDGER} records no minted runtime identifiers`,
      'Fix: record every app version this project has shipped a binary at, with its Expo SDK major.',
    )
  } else {
    const malformed = []
    minted.forEach((entry, i) => {
      const okVersion = entry && typeof entry.appVersion === 'string' && entry.appVersion.length > 0
      const okMajor = entry && Number.isInteger(entry.expoSdkMajor)
      // Optional on any entry (the SDK 56 identifiers predate signatures and record none), but it
      // must be a real signature where it is present, and it is required on the last entry below.
      const okSignature =
        entry &&
        (entry.nativeSignature === undefined ||
          (typeof entry.nativeSignature === 'string' && SIGNATURE_PATTERN.test(entry.nativeSignature)))
      if (!okVersion || !okMajor || !okSignature) malformed.push(`minted[${i}]: ${JSON.stringify(entry)}`)
    })
    if (malformed.length > 0) {
      fail(
        `MALFORMED LEDGER ENTR${malformed.length === 1 ? 'Y' : 'IES'} in ${LEDGER}`,
        ...malformed,
        'Fix: every entry needs a non-empty string "appVersion" and an integer "expoSdkMajor".',
        `      "nativeSignature", where present, is ${SIGNATURE_LENGTH} lowercase hex characters.`,
      )
    } else {
      entries = minted
    }
  }
}

// ── No identifier may be minted twice, for any reason ────────────────────────

// Strictly stronger than the SDK-major comparison this replaces: two entries sharing an app version
// is always wrong, and keying on the SDK major let a same-major reuse through. It also means no
// check reads a historical entry's signature, which is what lets the three SDK 56 identifiers
// honestly record none.
if (entries) {
  const byVersion = new Map()
  entries.forEach((entry, i) => {
    if (!byVersion.has(entry.appVersion)) byVersion.set(entry.appVersion, [])
    byVersion.get(entry.appVersion).push({ ...entry, index: i })
  })
  for (const [version, claims] of byVersion) {
    if (claims.length > 1) {
      fail(
        `RUNTIME IDENTIFIER REUSED: app version ${version} is minted ${claims.length} times in ${LEDGER}`,
        ...claims.map(
          claim =>
            `minted[${claim.index}]: Expo SDK ${claim.expoSdkMajor}, native signature ${claim.nativeSignature ?? '(none on record)'}`,
        ),
        `Under the appVersion runtimeVersion policy, ${version} is one OTA runtime identifier, so`,
        'these entries describe two different binaries that both answer to it. A bundle published',
        'under it would be served to whichever one is installed, and only one of them can launch it.',
        'Fix: bump the app version for the newer native runtime instead of reusing this one.',
      )
    }
  }
}

// ── The tree must be the ledger's last entry, signature included ─────────────

if (entries && typeof appVersion === 'string' && currentSdkMajor !== null) {
  const last = entries[entries.length - 1]
  const index = entries.length - 1

  if (last.appVersion !== appVersion || last.expoSdkMajor !== currentSdkMajor) {
    fail(
      'LEDGER OUT OF DATE with the current tree',
      `current tree: app version ${appVersion}, Expo SDK ${currentSdkMajor} (from ${JSON.stringify(expoRange)})`,
      `ledger's last entry: app version ${last.appVersion}, Expo SDK ${last.expoSdkMajor}`,
      `Fix: append { "appVersion": "${appVersion}", "expoSdkMajor": ${currentSdkMajor}, "nativeSignature": "${currentSignature}" }`,
      `     to "minted" in ${LEDGER}. If that app version is already in the ledger, bump the app`,
      '     version in both mobile manifests first — never reuse an identifier.',
    )
  } else if (currentSignature !== null && last.nativeSignature === undefined) {
    fail(
      `MISSING NATIVE SIGNATURE: ${LEDGER} minted[${index}] (${last.appVersion}) records none`,
      `The newest identifier must record the native surface it was minted for, or nothing can tell`,
      'a later native change from the tree it describes.',
      `Fix: add "nativeSignature": "${currentSignature}" to minted[${index}].`,
    )
  } else if (currentSignature !== null && last.nativeSignature !== currentSignature) {
    fail(
      'NATIVE SURFACE CHANGED without a new runtime identifier',
      `current tree:        ${currentSignature}`,
      `minted[${index}] (${last.appVersion}): ${last.nativeSignature}`,
      `Identifier ${appVersion} already describes a different native runtime, so a binary built`,
      'from this tree and a binary built from the recorded one would both answer to it. An OTA',
      'bundle from here would be served to the older binary and crash it at launch.',
      'Fix, in two steps: bump "version" in both mobile manifests, then append',
      `     { "appVersion": "<new version>", "expoSdkMajor": ${currentSdkMajor}, "nativeSignature": "${currentSignature}" }`,
      `     to "minted" in ${LEDGER}. Leave the existing entries exactly as they are.`,
      'If you believe nothing native changed, see the blind-spot list at the top of this script for',
      'what the signature does and does not cover before editing a recorded entry.',
    )
  }
}

// ── The ledger is append-only, checked against an explicit baseline ──────────

let appendOnlyNote = 'append-only NOT checked (no --base)'

if (baseRef) {
  appendOnlyNote = `append-only verified against ${baseRef}`

  let resolvedRef = null
  try {
    resolvedRef = git(['rev-parse', '--verify', `${baseRef}^{commit}`]).trim()
  } catch (err) {
    appendOnlyNote = null
    fail(
      `CANNOT READ BASELINE: --base ${baseRef} does not resolve to a commit here`,
      (err.stderr || err.message || '').toString().trim(),
      'Fix: pass a ref this checkout has. In CI, "HEAD^1" needs actions/checkout with',
      '     fetch-depth: 2 or more; locally, fetch the base branch first.',
      '     Something asked for the append-only check explicitly, so it fails rather than skips.',
    )
  }

  if (resolvedRef) {
    let baselineText = null
    try {
      baselineText = git(['show', `${resolvedRef}:${LEDGER}`])
    } catch {
      // The ledger did not exist at the baseline — it is being introduced in this change. There is
      // nothing to contradict, so this is not a failure.
      appendOnlyNote = `append-only not applicable (${LEDGER} absent at ${baseRef})`
    }

    if (baselineText !== null) {
      let baselineMinted = null
      try {
        const parsed = JSON.parse(baselineText)
        if (!Array.isArray(parsed?.minted)) throw new Error('no "minted" array')
        baselineMinted = parsed.minted
      } catch (err) {
        appendOnlyNote = null
        fail(
          `CANNOT READ BASELINE: ${LEDGER} at ${baseRef} is not a usable ledger`,
          err.message,
          'Fix: the append-only check needs a parseable baseline. Point --base at a commit whose',
          '     ledger is valid, or drop --base and say so in the run that depends on it.',
        )
      }

      if (baselineMinted && Array.isArray(minted)) {
        if (minted.length < baselineMinted.length) {
          fail(
            `APPEND-ONLY VIOLATION: ${LEDGER} lost entries since ${baseRef}`,
            `baseline: ${baselineMinted.length} entr${baselineMinted.length === 1 ? 'y' : 'ies'}; current: ${minted.length}`,
            'A minted identifier is a fact about a binary that exists. Deleting it does not unship',
            'the binary, it just removes the record that would have caught the next collision.',
            'Fix: restore the removed entries and append rather than replace.',
          )
        }

        baselineMinted.forEach((baseEntry, i) => {
          const current = minted[i]
          if (current === undefined) return // already reported by the length check above
          const changes = []
          for (const key of Object.keys(baseEntry ?? {})) {
            if (!Object.prototype.hasOwnProperty.call(current ?? {}, key)) {
              changes.push(`${key} was removed (was ${JSON.stringify(baseEntry[key])})`)
            } else if (!deepEqual(current[key], baseEntry[key])) {
              changes.push(
                `${key}: ${JSON.stringify(baseEntry[key])} at ${baseRef} → ${JSON.stringify(current[key])} now`,
              )
            }
          }
          if (changes.length > 0) {
            fail(
              `APPEND-ONLY VIOLATION: ${LEDGER} minted[${i}] was changed since ${baseRef}`,
              ...changes,
              'This entry records an identifier that was already minted. Editing it does not change',
              'what any installed binary asks for — it only deletes the claim that would have caught',
              'the reuse, which is the defect this ledger exists to prevent.',
              'Fix: leave the entry as it was and append a new one for the new native runtime.',
              '     Adding a NEW key to an old entry is allowed; changing or removing one is not.',
            )
          }
        })
      }
    }
  }
}

// ── Report ───────────────────────────────────────────────────────────────────

if (errors.length === 0) {
  console.log(
    `✓  check-mobile-runtime passed — OTA runtime identifier ${appVersion} is minted for ` +
      `Expo SDK ${currentSdkMajor} with native signature ${currentSignature} ` +
      `(${entries.length} identifier(s) on record); ${appendOnlyNote}`,
  )
  process.exit(0)
}

for (const [message, detail] of errors) {
  console.error(`\n✕  ${message}`)
  for (const line of detail) console.error(`   ${line}`)
}
console.error(`\n${errors.length} problem(s) found. Fix before publishing an OTA update or a build.`)
process.exit(1)
