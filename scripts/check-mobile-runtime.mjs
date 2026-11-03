#!/usr/bin/env node
/**
 * Guards the mobile OTA runtime identifier.
 *
 * mobile/app.json sets `runtimeVersion: { policy: "appVersion" }`, so the OTA
 * runtime identifier an EAS Update is published under *is* the literal app
 * version. An installed binary only accepts a bundle whose runtime identifier
 * matches its own. Reusing one app version across two Expo SDK majors therefore
 * tells Expo that an SDK 58 JS bundle is compatible with an SDK 56 binary, which
 * it is not: the bundle references native modules that binary does not contain,
 * and the app crashes at launch.
 *
 * mobile/runtime-versions.json is the append-only ledger of every identifier
 * this project has minted and the SDK major it was minted for. This script
 * fails when the current tree would reuse an identifier across SDK majors, when
 * the tree is ahead of the ledger, or when app.json and package.json disagree
 * on the version.
 *
 * Fix when it fails: bump `version` in BOTH mobile/app.json and
 * mobile/package.json, and append the new { appVersion, expoSdkMajor } pair to
 * mobile/runtime-versions.json. Never reuse an identifier.
 */

import { readFileSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const APP_JSON = 'mobile/app.json'
const PKG_JSON = 'mobile/package.json'
const LEDGER = 'mobile/runtime-versions.json'

const errors = []

function fail(message, ...detail) {
  errors.push([message, detail])
}

function readJson(relPath) {
  try {
    return JSON.parse(readFileSync(join(ROOT, relPath), 'utf8'))
  } catch (err) {
    fail(`CANNOT READ: ${relPath}`, err.message)
    return null
  }
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

// ── The two files must agree ─────────────────────────────────────────────────

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

const expoRange = pkgJson?.dependencies?.expo
let currentSdkMajor = null

if (typeof expoRange !== 'string') {
  if (pkgJson) fail(`MISSING DEPENDENCY: ${PKG_JSON} has no string "dependencies"."expo"`)
} else {
  const match = expoRange.match(/(\d+)/)
  if (!match) {
    fail(
      `UNPARSEABLE EXPO RANGE: ${PKG_JSON} "dependencies"."expo" is ${JSON.stringify(expoRange)}`,
      'Fix: use a range this script can read a major out of, e.g. "^58.0.23".',
    )
  } else {
    currentSdkMajor = Number(match[1])
  }
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
      if (!okVersion || !okMajor) malformed.push(`minted[${i}]: ${JSON.stringify(entry)}`)
    })
    if (malformed.length > 0) {
      fail(
        `MALFORMED LEDGER ENTR${malformed.length === 1 ? 'Y' : 'IES'} in ${LEDGER}`,
        ...malformed,
        'Fix: every entry needs a non-empty string "appVersion" and an integer "expoSdkMajor".',
      )
    } else {
      entries = minted
    }
  }
}

// ── No identifier may be claimed by two SDK majors ───────────────────────────

if (entries) {
  const majorsByVersion = new Map()
  for (const { appVersion: version, expoSdkMajor } of entries) {
    if (!majorsByVersion.has(version)) majorsByVersion.set(version, new Set())
    majorsByVersion.get(version).add(expoSdkMajor)
  }
  for (const [version, majors] of majorsByVersion) {
    if (majors.size > 1) {
      const list = [...majors].sort((a, b) => a - b)
      fail(
        `RUNTIME IDENTIFIER REUSED: app version ${version} is claimed by Expo SDK ${list.join(' and SDK ')}`,
        `Under the appVersion runtimeVersion policy, ${version} is one OTA runtime identifier.`,
        `An SDK ${list[list.length - 1]} bundle published under it would be served to installed`,
        `SDK ${list[0]} binaries, which cannot launch it.`,
        'Fix: bump the app version for the newer SDK instead of reusing this one.',
      )
    }
  }
}

// ── The tree must be the ledger's last entry ─────────────────────────────────

if (entries && typeof appVersion === 'string' && currentSdkMajor !== null) {
  const last = entries[entries.length - 1]
  if (last.appVersion !== appVersion || last.expoSdkMajor !== currentSdkMajor) {
    fail(
      'LEDGER OUT OF DATE with the current tree',
      `current tree: app version ${appVersion}, Expo SDK ${currentSdkMajor} (from ${JSON.stringify(expoRange)})`,
      `ledger's last entry: app version ${last.appVersion}, Expo SDK ${last.expoSdkMajor}`,
      `Fix: append { "appVersion": "${appVersion}", "expoSdkMajor": ${currentSdkMajor} } to "minted"`,
      `     in ${LEDGER}. If that app version is already in the ledger under a different SDK major,`,
      '     bump the app version in both mobile manifests first — never reuse an identifier.',
    )
  }
}

// ── Report ───────────────────────────────────────────────────────────────────

if (errors.length === 0) {
  console.log(
    `✓  check-mobile-runtime passed — OTA runtime identifier ${appVersion} is minted for ` +
      `Expo SDK ${currentSdkMajor} only (${entries.length} identifier(s) on record)`,
  )
  process.exit(0)
}

for (const [message, detail] of errors) {
  console.error(`\n✕  ${message}`)
  for (const line of detail) console.error(`   ${line}`)
}
console.error(`\n${errors.length} problem(s) found. Fix before publishing an OTA update or a build.`)
process.exit(1)
