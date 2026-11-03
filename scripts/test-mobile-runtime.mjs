#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Regression test for scripts/check-mobile-runtime.mjs. The guard reads three JSON files relative
// to its own parent directory and spawns `git`, so every case here is a throwaway tree holding a
// copy of the script plus the three files — the same way the two defects this test exists for were
// originally reproduced by hand — and the guard is run as a child process so the assertions are on
// the exit code and the failure label a human or CI would actually see.
//
// Nothing here needs node_modules, in mobile/ or anywhere else.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(ROOT, 'scripts', 'check-mobile-runtime.mjs')

const APP = JSON.parse(readFileSync(join(ROOT, 'mobile', 'app.json'), 'utf8'))
const PKG = JSON.parse(readFileSync(join(ROOT, 'mobile', 'package.json'), 'utf8'))
const LEDGER = JSON.parse(readFileSync(join(ROOT, 'mobile', 'runtime-versions.json'), 'utf8'))

const passed = []

// A deep clone per case, so a mutation in one case cannot leak into the next.
const clone = value => JSON.parse(JSON.stringify(value))

function makeTree({ app = APP, pkg = PKG, ledger = LEDGER } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qalatra-runtime-guard-'))
  mkdirSync(join(dir, 'scripts'))
  mkdirSync(join(dir, 'mobile'))
  copyFileSync(SCRIPT, join(dir, 'scripts', 'check-mobile-runtime.mjs'))
  writeTree(dir, { app, pkg, ledger })
  return dir
}

// `undefined` leaves a file as it is; `null` means the tree does not have it at all.
function writeTree(dir, { app, pkg, ledger } = {}) {
  if (app !== undefined) writeFileSync(join(dir, 'mobile', 'app.json'), `${JSON.stringify(app, null, 2)}\n`)
  if (pkg !== undefined) writeFileSync(join(dir, 'mobile', 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
  if (ledger === null) {
    rmSync(join(dir, 'mobile', 'runtime-versions.json'), { force: true })
  } else if (ledger !== undefined) {
    writeFileSync(join(dir, 'mobile', 'runtime-versions.json'), `${JSON.stringify(ledger, null, 2)}\n`)
  }
}

// `-c user.*` locally rather than a global config, so the test does not depend on — or modify — the
// runner's git identity. `commit.gpgsign=false` keeps it working on a machine that signs by default.
function git(dir, args) {
  execFileSync(
    'git',
    ['-c', 'user.email=test@qalatra.local', '-c', 'user.name=Qalatra Test', '-c', 'commit.gpgsign=false', ...args],
    { cwd: dir, stdio: 'ignore' },
  )
}

// A tree whose baseline commit holds `baseline` and whose working tree holds `head`, so `--base HEAD`
// is a real "what was on the base branch before this change" comparison.
function makeGitTree({ baseline, head }) {
  const dir = makeTree(baseline)
  git(dir, ['init', '-q'])
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'baseline'])
  writeTree(dir, head)
  return dir
}

function run(dir, args = []) {
  const result = spawnSync(process.execPath, [join(dir, 'scripts', 'check-mobile-runtime.mjs'), ...args], {
    encoding: 'utf8',
  })
  return { code: result.status, output: `${result.stdout}${result.stderr}` }
}

function check(label, { tree, args = [], code, includes = [], excludes = [] }) {
  const dir = tree()
  try {
    const result = run(dir, args)
    assert.equal(
      result.code,
      code,
      `${label}: expected exit ${code}, got ${result.code}\n${result.output}`,
    )
    for (const needle of includes) {
      assert.ok(result.output.includes(needle), `${label}: output is missing ${JSON.stringify(needle)}\n${result.output}`)
    }
    for (const needle of excludes) {
      assert.ok(!result.output.includes(needle), `${label}: output should not contain ${JSON.stringify(needle)}\n${result.output}`)
    }
    passed.push(label)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ── The current tree passes, and says what it checked ────────────────────────

const currentSignature = LEDGER.minted[LEDGER.minted.length - 1].nativeSignature
assert.match(currentSignature, /^[0-9a-f]{12}$/, 'the ledger\'s last entry must record a native signature')

check('the repository\'s own tree passes, and the pass line names the signature', {
  tree: () => makeTree(),
  code: 0,
  includes: ['check-mobile-runtime passed', currentSignature, 'append-only NOT checked (no --base)'],
})

// ── Finding (2): a native change inside one Expo SDK major ───────────────────
// Adding a native module with `expo` still on ^58 and `version` still 0.4.0 changed nothing the
// merged guard looked at, so it exited 0 and minted a second binary at identifier 0.4.0.
// expo-system-ui is the real case: open task 4b67b925 is about installing it.

check('a native module added inside one Expo SDK major is caught', {
  tree: () =>
    makeTree({
      pkg: (() => {
        const pkg = clone(PKG)
        pkg.dependencies['expo-system-ui'] = '~6.0.0'
        return pkg
      })(),
    }),
  code: 1,
  includes: ['NATIVE SURFACE CHANGED without a new runtime identifier', currentSignature],
})

// A pure-JS dependency bump must NOT mint a new identifier — over-inclusion in the signature is
// the silent-non-delivery failure mode this repo already rejected the `fingerprint` policy for.
check('a pure-JS dependency bump does not change the signature', {
  tree: () =>
    makeTree({
      pkg: (() => {
        const pkg = clone(PKG)
        pkg.dependencies['react-native-markdown-display'] = '^99.0.0'
        pkg.dependencies['@react-navigation/native'] = '^99.0.0'
        pkg.devDependencies.typescript = '~99.0.0'
        return pkg
      })(),
    }),
  code: 0,
  includes: [currentSignature],
})

// ── The runtimeVersion policy is the premise of the whole ledger ─────────────

check('a changed runtimeVersion policy is caught', {
  tree: () =>
    makeTree({
      app: (() => {
        const app = clone(APP)
        app.expo.runtimeVersion = { policy: 'fingerprint' }
        return app
      })(),
    }),
  code: 1,
  includes: ['RUNTIME POLICY CHANGED'],
})

check('a deleted runtimeVersion block is caught', {
  tree: () =>
    makeTree({
      app: (() => {
        const app = clone(APP)
        delete app.expo.runtimeVersion
        return app
      })(),
    }),
  code: 1,
  includes: ['RUNTIME POLICY CHANGED'],
})

// ── An identifier may never be minted twice ──────────────────────────────────

check('a reused app version is caught, same SDK major included', {
  tree: () =>
    makeTree({
      ledger: (() => {
        const ledger = clone(LEDGER)
        ledger.minted.push({ appVersion: '0.4.0', expoSdkMajor: 58, nativeSignature: currentSignature })
        return ledger
      })(),
    }),
  code: 1,
  includes: ['RUNTIME IDENTIFIER REUSED: app version 0.4.0 is minted 2 times'],
})

// ── The tree must be the ledger's last entry ─────────────────────────────────

check('a version bump with no ledger entry is caught', {
  tree: () => {
    const app = clone(APP)
    const pkg = clone(PKG)
    app.expo.version = '0.5.0'
    pkg.version = '0.5.0'
    return makeTree({ app, pkg })
  },
  code: 1,
  includes: ['LEDGER OUT OF DATE with the current tree'],
})

check('a last entry with no native signature is caught', {
  tree: () =>
    makeTree({
      ledger: (() => {
        const ledger = clone(LEDGER)
        delete ledger.minted[ledger.minted.length - 1].nativeSignature
        return ledger
      })(),
    }),
  code: 1,
  includes: ['MISSING NATIVE SIGNATURE', `"nativeSignature": "${currentSignature}"`],
})

check('a signature that is not 12 hex characters is caught', {
  tree: () =>
    makeTree({
      ledger: (() => {
        const ledger = clone(LEDGER)
        ledger.minted[ledger.minted.length - 1].nativeSignature = 'NOTAHASH'
        return ledger
      })(),
    }),
  code: 1,
  includes: ['MALFORMED LEDGER ENTRY'],
})

// ── The Expo range parse ─────────────────────────────────────────────────────

for (const range of ['latest', '*', 'github:expo/expo#58', '>=57 <59']) {
  check(`an unreadable Expo range is caught: ${JSON.stringify(range)}`, {
    tree: () =>
      makeTree({
        pkg: (() => {
          const pkg = clone(PKG)
          pkg.dependencies.expo = range
          return pkg
        })(),
      }),
    code: 1,
    includes: ['UNPARSEABLE EXPO RANGE'],
  })
}

// ── The JS-only allowlist cannot rot ─────────────────────────────────────────

check('a stale JS-only allowlist entry is caught', {
  tree: () =>
    makeTree({
      pkg: (() => {
        const pkg = clone(PKG)
        delete pkg.dependencies['react-native-markdown-display']
        return pkg
      })(),
    }),
  code: 1,
  includes: ['STALE JS-ONLY ALLOWLIST'],
})

// ── Finding (1): the ledger is append-only, and now really is ────────────────
// Overwriting a claim leaves no duplicate for the collision check to find, so the merged guard
// exited 0 with a cheerful "0.4.0 is minted for Expo SDK 59 only". Catching it needs a baseline,
// which is what --base supplies.

const editedInPlace = () => {
  const ledger = clone(LEDGER)
  ledger.minted[3].expoSdkMajor = 59
  const pkg = clone(PKG)
  pkg.dependencies.expo = '^59.0.0'
  return { ledger, pkg }
}

check('--base catches a ledger claim overwritten in place', {
  tree: () => makeGitTree({ baseline: {}, head: editedInPlace() }),
  args: ['--base', 'HEAD'],
  code: 1,
  includes: ['APPEND-ONLY VIOLATION', 'minted[3] was changed', 'expoSdkMajor: 58 at HEAD → 59 now'],
})

check('the same overwrite passes the SDK-major collision rule, so --base is what catches it', {
  tree: () => makeGitTree({ baseline: {}, head: editedInPlace() }),
  args: ['--base', 'HEAD'],
  code: 1,
  excludes: ['RUNTIME IDENTIFIER REUSED'],
})

check('--base catches a removed ledger entry', {
  tree: () =>
    makeGitTree({
      baseline: {},
      head: {
        ledger: (() => {
          const ledger = clone(LEDGER)
          ledger.minted.splice(1, 1)
          return ledger
        })(),
      },
    }),
  args: ['--base', 'HEAD'],
  code: 1,
  includes: ['APPEND-ONLY VIOLATION', 'lost entries since HEAD'],
})

// This is the migration in this very change: the baseline's 0.4.0 entry has no nativeSignature and
// the current one does. A new fact about an old entry is exactly what append-only permits.
check('--base allows a new field added to an old entry', {
  tree: () =>
    makeGitTree({
      baseline: {
        ledger: (() => {
          const ledger = clone(LEDGER)
          delete ledger.minted[3].nativeSignature
          return ledger
        })(),
      },
      head: { ledger: clone(LEDGER) },
    }),
  args: ['--base', 'HEAD'],
  code: 0,
  includes: ['append-only verified against HEAD'],
  excludes: ['NOT checked'],
})

check('--base allows an appended entry', {
  tree: () => {
    const app = clone(APP)
    const pkg = clone(PKG)
    app.expo.version = '0.5.0'
    pkg.version = '0.5.0'
    pkg.dependencies['expo-system-ui'] = '~6.0.0'
    const dir = makeGitTree({ baseline: {}, head: { app, pkg } })
    // Mint 0.5.0 with whatever signature the guard computes for the bumped tree — the two-step fix
    // the NATIVE SURFACE CHANGED message tells a reader to apply.
    const output = run(dir, []).output
    const signature = output.match(/"nativeSignature": "([0-9a-f]{12})"/)?.[1]
    assert.ok(signature, `the guard must print the signature to record:\n${output}`)
    const ledger = clone(LEDGER)
    ledger.minted.push({ appVersion: '0.5.0', expoSdkMajor: 58, nativeSignature: signature })
    writeTree(dir, { ledger })
    return dir
  },
  args: ['--base', 'HEAD'],
  code: 0,
  includes: ['0.5.0', 'append-only verified against HEAD'],
})

// ── A baseline that was asked for must be readable ───────────────────────────

check('an unresolvable --base fails closed rather than passing quietly', {
  tree: () => makeGitTree({ baseline: {}, head: {} }),
  args: ['--base', 'refs/heads/no-such-branch'],
  code: 1,
  includes: ['CANNOT READ BASELINE'],
})

// But a baseline that simply predates the ledger is not a violation — there is nothing to
// contradict when the file is being introduced in the change under test.
check('a baseline with no ledger at all is reported, not failed', {
  tree: () => makeGitTree({ baseline: { ledger: null }, head: { ledger: clone(LEDGER) } }),
  args: ['--base', 'HEAD'],
  code: 0,
  includes: ['append-only not applicable'],
})

check('an unparseable baseline ledger fails closed', {
  tree: () => {
    const dir = makeTree()
    git(dir, ['init', '-q'])
    writeFileSync(join(dir, 'mobile', 'runtime-versions.json'), '{ not json')
    git(dir, ['add', '-A'])
    git(dir, ['commit', '-q', '-m', 'baseline'])
    writeTree(dir, { ledger: clone(LEDGER) })
    return dir
  },
  args: ['--base', 'HEAD'],
  code: 1,
  includes: ['CANNOT READ BASELINE'],
})

// ── Report ───────────────────────────────────────────────────────────────────

for (const label of passed) console.log(`  ✓ ${label}`)
console.log(`\ncheck-mobile-runtime tests passed (${passed.length} cases)`)
