// scripts/test-agent-scan.mjs
// The agent scan's root, skips and limits (server/agents.js), the shared scan (server/workers.js)
// and registry pruning (server/capability-registry.js).
//
// A fresh install with no root set used to scan the whole home folder, walk into
// ~/Library/CloudStorage (where a streaming Drive mount downloads every package it touches) and
// never answer. See docs/bug-agent-scan-home-fallback.md.
//
//   node scripts/test-agent-scan.mjs

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { resolveAgentsRoot, expandHome, scanAgentTree, scanAgents, shouldEnter } from '../server/agents.js'
import { scanConfiguredAgents } from '../server/workers.js'
import { syncScannedAgents } from '../server/capability-registry.js'

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qalatra-agent-scan-')))
const home = os.homedir()

let failures = 0
async function test(name, fn) {
  try { await fn(); console.log(`PASS  ${name}`) }
  catch (err) { failures++; console.log(`FAIL  ${name}\n      ${err.stack || err}`) }
}

function agentAt(dir, name = path.basename(dir)) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'agent.config'), JSON.stringify({ name }))
  return dir
}

const quietly = async fn => {
  const { warn, error } = console
  console.warn = () => {}; console.error = () => {}
  try { return await fn() } finally { console.warn = warn; console.error = error }
}

try {
  await test('resolveAgentsRoot: agentsRoot, then workspaceRoot, then terminalCwd, else null', () => {
    assert.equal(resolveAgentsRoot({}), null)
    assert.equal(resolveAgentsRoot({ agentsRoot: '', workspaceRoot: '  ', terminalCwd: '' }), null)
    assert.equal(resolveAgentsRoot(undefined), null)
    assert.deepEqual(resolveAgentsRoot({ terminalCwd: '/t' }), { root: '/t', setting: 'terminalCwd' })
    assert.deepEqual(resolveAgentsRoot({ workspaceRoot: '/w', terminalCwd: '/t' }), { root: '/w', setting: 'workspaceRoot' })
    assert.deepEqual(resolveAgentsRoot({ agentsRoot: '/a', workspaceRoot: '/w', terminalCwd: '/t' }), { root: '/a', setting: 'agentsRoot' })
    assert.deepEqual(resolveAgentsRoot({ agentsRoot: '/a/b/../c/' }), { root: '/a/c', setting: 'agentsRoot' })
  })

  await test('resolveAgentsRoot expands ~', () => {
    assert.equal(resolveAgentsRoot({ agentsRoot: '~/qalatra-demo' }).root, path.join(home, 'qalatra-demo'))
    assert.equal(resolveAgentsRoot({ workspaceRoot: '~' }).root, home)
    assert.equal(expandHome('~other/x'), '~other/x')
  })

  await test('the scan skips Library, cloud mounts, packages, dot-folders and symlinks, and stops at the depth limit', async () => {
    const root = path.join(tmp, 'tree')
    const found = [
      agentAt(path.join(root, 'proj', 'agents', 'a')),
      agentAt(path.join(root, 'proj', 'Library', 'agents', 'b')), // Library in a project is ordinary
      agentAt(path.join(root, 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8', 'd9', 'ok')), // depth 10
    ]
    agentAt(path.join(root, 'CloudStorage', 'GoogleDrive-x', 'agent'))
    agentAt(path.join(root, 'Mobile Documents', 'agent'))
    agentAt(path.join(root, 'Song.logicx', 'agent'))
    agentAt(path.join(root, 'Tool.app', 'Contents', 'agent'))
    agentAt(path.join(root, '.claude', 'worktrees', 'w1', 'agents', 'a'))
    agentAt(path.join(root, '.cache', 'agent'))
    agentAt(path.join(root, 'proj', 'node_modules', 'pkg'))
    agentAt(path.join(root, 'proj', 'dist', 'agent'))
    agentAt(path.join(root, 'proj', '.qalatra-worktrees', 'T-1', 'agents', 'a'))
    agentAt(path.join(root, 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8', 'd9', 'd10', 'deep')) // depth 11
    const outside = agentAt(path.join(tmp, 'elsewhere', 'agent'))
    fs.symlinkSync(path.dirname(outside), path.join(root, 'linked'))

    const { agents, truncated } = await quietly(() => scanAgentTree(root))
    assert.equal(truncated, null)
    assert.deepEqual(agents.map(a => a.path).sort(), found.sort())
  })

  await test('Library is skipped directly under a home folder only', () => {
    assert.equal(shouldEnter(home, 'Library'), false)
    assert.equal(shouldEnter('/Users/someone', 'Library'), false)
    assert.equal(shouldEnter('/home/someone', 'Library'), false)
    assert.equal(shouldEnter(path.join(home, 'proj'), 'Library'), true)
    assert.equal(shouldEnter('/', 'Volumes'), false)
    assert.equal(shouldEnter('/', 'proc'), false)
    assert.equal(shouldEnter('/srv', 'proc'), true)
    assert.equal(shouldEnter('/x', 'Photos Library.photoslibrary'), false)
    assert.equal(shouldEnter('/x', 'sandbox', new Set(['sandbox'])), false)
  })

  await test('the folder cap stops the walk and reports it', async () => {
    const root = path.join(tmp, 'wide')
    for (let i = 0; i < 30; i++) fs.mkdirSync(path.join(root, `d${i}`), { recursive: true })
    const { truncated, visited } = await quietly(() => scanAgentTree(root, [], { maxDirs: 10 }))
    assert.equal(truncated, 'dirs')
    assert.equal(visited, 10)
  })

  await test('a folder that never answers stops the walk instead of hanging it', async () => {
    const root = path.join(tmp, 'hang')
    agentAt(path.join(root, 'a', 'agent'))
    fs.mkdirSync(path.join(root, 'stuck'), { recursive: true })
    const real = fs.promises.readdir
    fs.promises.readdir = (dir, opts) => dir.endsWith(`${path.sep}stuck`) ? new Promise(() => {}) : real(dir, opts)
    try {
      const started = Date.now()
      const { truncated } = await quietly(() => scanAgentTree(root, [], { readdirTimeoutMs: 50 }))
      assert.equal(truncated, 'readdir')
      assert.ok(Date.now() - started < 2000)
    } finally { fs.promises.readdir = real }
  })

  await test('scanAgents still returns a plain array', async () => {
    const agents = await quietly(() => scanAgents(path.join(tmp, 'tree')))
    assert.ok(Array.isArray(agents) && agents.length === 3)
  })

  await test('no root configured: nothing is read and nothing is written', async () => {
    const real = fs.promises.readdir
    let reads = 0
    fs.promises.readdir = (...args) => { reads++; return real(...args) }
    const calls = []
    try {
      const out = await quietly(() => scanConfiguredAgents({ dbCall: async (...a) => { calls.push(a) }, loadSettings: () => ({}) }))
      assert.deepEqual(out, { agents: [], root: null, truncated: null })
    } finally { fs.promises.readdir = real }
    assert.equal(reads, 0)
    assert.deepEqual(calls, [])
  })

  await test('workspaceRoot alone is scanned; concurrent requests share one walk; a full walk prunes outside the root', async () => {
    const root = path.join(tmp, 'tree')
    const calls = []
    const ctx = { dbCall: async (...a) => { calls.push(a) }, loadSettings: () => ({ workspaceRoot: root }) }
    const [a, b] = await quietly(() => Promise.all([scanConfiguredAgents(ctx), scanConfiguredAgents(ctx)]))
    assert.equal(a, b)
    assert.equal(a.root, root)
    assert.equal(a.agents.length, 3)
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0][2], { root, pruneOutsideRoot: true })
  })

  await test('a truncated walk upserts without pruning', async () => {
    const root = path.join(tmp, 'hang')
    const calls = []
    const real = fs.promises.readdir
    fs.promises.readdir = (dir, opts) => dir.endsWith(`${path.sep}stuck`)
      ? Promise.reject(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }))
      : real(dir, opts)
    try {
      const out = await quietly(() => scanConfiguredAgents({ dbCall: async (...a) => { calls.push(a) }, loadSettings: () => ({ agentsRoot: root }) }))
      assert.equal(out.truncated, 'readdir')
    } finally { fs.promises.readdir = real }
    assert.deepEqual(calls[0][2], {})
  })

  await test('pruneOutsideRoot drops agents left over from a wider root; without it they stay', () => {
    const db = new Database(':memory:')
    const root = path.join(tmp, 'tree')
    const stray = path.join(tmp, 'elsewhere', 'agent') // still on disk, outside the root
    const inRoot = path.join(root, 'proj', 'agents', 'a')
    const row = p => ({ path: p, name: path.basename(p), relativePath: '', folder: null, capability: null })
    syncScannedAgents(db, [row(inRoot), row(stray)])
    const paths = () => db.prepare('SELECT path FROM agents ORDER BY path').pluck().all()

    const narrow = syncScannedAgents(db, [row(inRoot)], { root })
    assert.deepEqual(narrow.removedAgents, [])
    assert.deepEqual(paths(), [stray, inRoot].sort())

    const full = syncScannedAgents(db, [row(inRoot)], { root, pruneOutsideRoot: true })
    assert.deepEqual(full.removedAgents, [stray])
    assert.deepEqual(paths(), [inRoot])
  })
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

if (failures) { console.log(`\n${failures} failed`); process.exit(1) }
console.log('\nall agent scan tests passed')
