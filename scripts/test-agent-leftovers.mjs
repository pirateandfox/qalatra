import assert from 'node:assert/strict'
import { abandonedWork, formatAbandonedNotice, scopeProcesses, toolCommand } from '../server/agent-leftovers.js'

// Claude Code's Bash tool wrapper, as it appears in /proc/<pid>/cmdline (NUL-separated argv).
const toolShell = command => ['/usr/bin/zsh', '-c', `source /home/a/.claude/shell-snapshots/snapshot-zsh-1-abc.sh 2>/dev/null || true && setopt NO_EXTENDED_GLOB 2>/dev/null || true && eval '${command.replaceAll("'", "'\\''")}' < /dev/null && pwd -P >| /tmp/claude-1-cwd`].join('\0') + '\0'

// Only the agent's tool shells count. The build they started, MCP servers and zombies do not.
const files = {
  '/scope/cgroup.procs': '11\n12\n13\n14\n15\n',
  '/proc/11/cmdline': toolShell('pnpm db-update 2>&1 | tail -20'),
  '/proc/12/cmdline': '',
  '/proc/13/cmdline': 'node\0node_modules/.bin/tsc\0-b\0',
  '/proc/14/cmdline': 'npm exec @notionhq/notion-mcp-server\0',
}
const readFile = f => { if (f in files) return files[f]; throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }
assert.deepEqual(scopeProcesses('/scope', { readFile }), [{ pid: 11, command: 'pnpm db-update 2>&1 | tail -20' }])
assert.deepEqual(scopeProcesses('/scope', { readFile: f => f.endsWith('procs') ? '14\n' : readFile(f) }), [], 'an MCP server outliving the agent is not work')
assert.deepEqual(scopeProcesses('/gone', { readFile }), [], 'a collected scope has nothing left')
assert.deepEqual(scopeProcesses(null, { readFile }), [], 'no scope (macOS, no slice) has nothing left')
assert.equal(scopeProcesses('/scope', { readFile: f => f.endsWith('procs') ? '1\n' : toolShell('x'.repeat(1000)) })[0].command.length, 300)

// The evaled command comes back unquoted; anything else is shown whole.
assert.equal(toolCommand(toolShell("echo 'still compiling' && sleep 600").replaceAll('\0', ' ')), "echo 'still compiling' && sleep 600")
assert.equal(toolCommand('zsh -c source /x/shell-snapshots/snapshot-1.sh && make'), 'zsh -c source /x/shell-snapshots/snapshot-1.sh && make')

// Children that exit inside the grace period (stdio MCP servers closing) are not abandoned work.
const sleep = async () => {}
let calls = 0
const draining = () => (++calls < 3 ? [{ pid: 1, command: 'mcp-server' }] : [])
assert.deepEqual(await abandonedWork('/scope', { list: draining, sleep, graceMs: 2000, pollMs: 200 }), [])
assert.equal(calls, 3, 'stops polling once the scope drains')

// Work still running after the grace period is reported.
calls = 0
const stuck = () => { calls++; return [{ pid: 7, command: 'pnpm db-update' }] }
assert.deepEqual(await abandonedWork('/scope', { list: stuck, sleep, graceMs: 1000, pollMs: 200 }), [{ pid: 7, command: 'pnpm db-update' }])
assert.equal(calls, 6, 'one look, then one per poll for the whole grace period')

calls = 0
assert.deepEqual(await abandonedWork('/scope', { list: () => { calls++; return [] }, sleep }), [])
assert.equal(calls, 1, 'an empty scope costs one read and no wait')

// The notice names the work, stays inside FlightDesk's 4096-character tail, and is not read as an OOM.
const one = formatAbandonedNotice([{ pid: 7, command: 'pnpm db-update' }])
assert.match(one, /ended its turn while work it started was still running/)
assert.match(one, /\(1 process\):\n  - pnpm db-update\n/)
assert.doesNotMatch(one, /out of memory|\bOOM\b|OOM-killed|memory limit/i)
const many = formatAbandonedNotice(Array.from({ length: 20 }, (_, i) => ({ pid: i, command: 'x'.repeat(300) })))
assert.match(many, /\(20 processes\)/)
assert.match(many, /…and 12 more/)
assert.ok(many.length < 4096, `notice is ${many.length} chars`)

console.log('agent-leftovers: ok')
