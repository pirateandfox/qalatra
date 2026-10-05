import assert from 'node:assert/strict'
import {
  argvCommandError,
  buildSystemdAgentLauncher,
  resolveAgentMemoryLimits,
  commandDiagnosticLines,
  commandHasPlaceholder,
  isArgvCommand,
  replaceShellPlaceholder,
  resolveArgvTemplate,
  resumeMessageForJob,
  templateEnv,
} from '../server/workers.js'
import { commandBinary, getRuntime, inferRuntime } from '../server/agent-runtimes.js'

const warnings = []
const onWarn = message => warnings.push(message)

assert.equal(
  replaceShellPlaceholder("flightdesk --prompt '{description}'", 'description', 'Execute the plan', { onWarn }),
  "flightdesk --prompt 'Execute the plan'",
)
assert.equal(warnings.length, 0, 'an exactly quote-delimited placeholder must not warn')

assert.equal(
  replaceShellPlaceholder('flightdesk --title {title}', 'title', 'Ship it', { onWarn }),
  "flightdesk --title 'Ship it'",
)
assert.equal(warnings.length, 0, 'a bare placeholder remains supported without a warning')

assert.equal(
  replaceShellPlaceholder("flightdesk --prompt '{description}\n\nmore text'", 'description', 'Execute the plan', { onWarn }),
  "flightdesk --prompt ''Execute the plan'\n\nmore text'",
)
assert.equal(warnings.length, 1)
assert.match(warnings[0], /unsafe quoted \{description\} placeholder/)

assert.equal(
  replaceShellPlaceholder('flightdesk --title "{title} suffix"', 'title', 'Ship it', { onWarn }),
  "flightdesk --title \"'Ship it' suffix\"",
)
assert.equal(warnings.length, 2)
assert.match(warnings[1], /unsafe quoted \{title\} placeholder/)

const diagnostics = commandDiagnosticLines(
  "runner --token secret '{description}'",
  "runner --token secret 'Execute the plan'",
)
assert.deepEqual(diagnostics, [
  "- command template: runner --token [redacted] '{description}'",
  "- resolved command: runner --token [redacted] 'Execute the plan'",
])

// Argv form: no shell, so placeholder values are argv entries and nothing is quoted.
warnings.length = 0
const argvTemplate = ['flightdesk', 'register', '--title', '{title}', '--prompt=Task: {description}', '--spec', '{spec_file}']
assert.equal(isArgvCommand(argvTemplate), true)
assert.equal(isArgvCommand('flightdesk register'), false)
assert.equal(commandHasPlaceholder(argvTemplate), true)
assert.equal(commandHasPlaceholder(['claude', '--dangerously-skip-permissions']), false)
assert.equal(commandHasPlaceholder("flightdesk --prompt '{description}'"), true)
assert.equal(argvCommandError(argvTemplate), null)
assert.equal(argvCommandError('a string'), null)
assert.match(argvCommandError([]), /array is empty/)
assert.match(argvCommandError(['flightdesk', 3]), /element 1 must be a non-empty string/)
assert.match(argvCommandError(['flightdesk', '']), /element 1 must be a non-empty string/)

const tricky = `Execute "the" plan; rm -rf / && echo 'it'\n\nsecond line`
assert.deepEqual(
  resolveArgvTemplate(argvTemplate, { title: "Ship it's", description: tricky, spec_file: './spec-1.md' }, { onWarn }),
  ['flightdesk', 'register', '--title', "Ship it's", `--prompt=Task: ${tricky}`, '--spec', './spec-1.md'],
  'argv placeholders are spliced verbatim: no quoting, no newline flattening',
)
assert.equal(warnings.length, 0)
assert.deepEqual(
  resolveArgvTemplate(['runner', '{spec_file}'], { title: 't', description: 'd' }, { onWarn }),
  ['runner', ''],
  'a missing value resolves to an empty argument rather than the literal placeholder',
)
assert.equal(warnings.length, 0)
assert.deepEqual(
  resolveArgvTemplate(['runner', "'{description}'"], { description: 'Execute the plan' }, { onWarn }),
  ['runner', "'Execute the plan'"],
)
assert.equal(warnings.length, 1)
assert.match(warnings[0], /argv elements are not shell-parsed/)

// The shell-string warning now points at the two safe alternatives.
warnings.length = 0
replaceShellPlaceholder("flightdesk --prompt '{description} extra'", 'description', 'x', { onWarn })
assert.match(warnings[0], /\$QALATRA_DESCRIPTION/)
assert.match(warnings[0], /argv array/)

// Task values reach every run through the environment, so a shell-string command can reference
// "$QALATRA_DESCRIPTION" instead of splicing the value into the command text.
const env = templateEnv({ job: { id: 'job-1', task_id: 'task-9' }, values: { title: 'T', description: 'D', spec_file: './spec-job-1.md' } })
assert.deepEqual(env, {
  QALATRA_JOB_ID: 'job-1',
  QALATRA_TITLE: 'T',
  QALATRA_DESCRIPTION: 'D',
  QALATRA_TASK_ID: 'task-9',
  QALATRA_SPEC_FILE: './spec-job-1.md',
})
const noTask = templateEnv({ job: { id: 7 }, values: { title: '', description: '' } })
assert.equal(noTask.QALATRA_TASK_ID, undefined)
assert.equal(noTask.QALATRA_SPEC_FILE, undefined)
assert.equal(noTask.QALATRA_JOB_ID, '7')
const huge = templateEnv({ job: { id: 1 }, values: { title: '', description: 'x'.repeat(200_000) } })
assert.ok(huge.QALATRA_DESCRIPTION.length < 70_000, 'env values are capped below the per-string environment limit')
assert.match(huge.QALATRA_DESCRIPTION, /truncated to 65536 characters/)

const argvDiagnostics = commandDiagnosticLines(
  ['runner', '--token', 'secret', '{description}'],
  ['runner', '--token', 'secret', 'Execute the plan'],
)
assert.deepEqual(argvDiagnostics, [
  '- command template: runner --token [redacted] {description}',
  '- resolved command: runner --token [redacted] "Execute the plan"',
])

const launcher = buildSystemdAgentLauncher('job/unsafe value')
assert.equal(launcher.scopeUnit, 'qalatra-agent-job-unsafe-value.scope')
assert.deepEqual(launcher.args, [
  'systemd-run',
  '--user',
  '--scope',
  '--quiet',
  '--collect',
  '--unit=qalatra-agent-job-unsafe-value.scope',
  '--slice=qalatra-agents.slice',
  '--property=MemoryHigh=1G',
  '--property=MemoryMax=2G',
  '--property=OOMPolicy=kill',
])

const sized = buildSystemdAgentLauncher('job-1', { high: '2G', max: '3072M' })
assert.ok(sized.args.includes('--property=MemoryHigh=2G'))
assert.ok(sized.args.includes('--property=MemoryMax=3072M'))

const memoryWarnings = []
const onMemoryWarn = message => memoryWarnings.push(message)
const limits = (settings, cfg) => resolveAgentMemoryLimits(settings, cfg, { onWarn: onMemoryWarn })
assert.deepEqual(limits({}, null), { high: '1G', max: '2G' })
assert.deepEqual(limits({}, { memory_high: '2G', memory_max: '3G' }), { high: '2G', max: '3G' })
assert.deepEqual(limits({ agentMemoryHigh: '1.5G', agentMemoryMax: '3G' }, null), { high: '1.5G', max: '3G' })
// The folder overrides the box, one key at a time.
assert.deepEqual(limits({ agentMemoryHigh: '2G', agentMemoryMax: '4G' }, { memory_max: '6G' }), { high: '2G', max: '6G' })
assert.equal(memoryWarnings.length, 0)
// Unvalidated strings never reach systemd-run.
assert.deepEqual(limits({}, { memory_high: '2G --property=Delegate=yes', memory_max: '3G' }), { high: '1G', max: '3G' })
assert.deepEqual(limits({}, { memory_max: '2gb' }), { high: '1G', max: '2G' })
// max below high falls back to the layer beneath.
assert.deepEqual(limits({ agentMemoryHigh: '2G', agentMemoryMax: '3G' }, { memory_high: '4G' }), { high: '2G', max: '3G' })
assert.deepEqual(limits({}, { memory_high: '3G', memory_max: '2048M' }), { high: '1G', max: '2G' })
assert.equal(memoryWarnings.length, 4)

const accumulatedPrompt = `original task\n${'old agent output\n'.repeat(20_000)}`
assert.equal(
  resumeMessageForJob({
    task_id: 'task-123',
    prompt: accumulatedPrompt,
    user_message: 'Please apply the review feedback.',
  }),
  'Please apply the review feedback.',
  'a resumed turn must contain only the explicit new instruction',
)

const scheduledResume = resumeMessageForJob({
  task_id: 'task-123',
  prompt: accumulatedPrompt,
  user_message: null,
})
assert.match(scheduledResume, /Continue working on Qalatra task task-123/)
assert.ok(Buffer.byteLength(scheduledResume) < 512, 'a resumed run without feedback must stay compact')
assert.ok(!scheduledResume.includes('old agent output'), 'accumulated task history must not be replayed')

console.log('worker command-template tests passed')

// ── Runtime inference (no explicit agent.config runtime) ──────────────────────────────────────────
// Before inference, an absent runtime always meant claude, so `codex --yolo` was spawned with
// `-p … --output-format stream-json --verbose` appended and codex rejected it.
const runtimeWarnings = []
const infer = command => inferRuntime(command, { onWarn: m => runtimeWarnings.push(m) })
assert.equal(infer('claude --dangerously-skip-permissions'), 'claude')
assert.equal(infer('codex --yolo'), 'codex')
assert.equal(infer('codex exec --full-auto'), 'codex')
assert.equal(infer('/usr/local/bin/claude -c'), 'claude', 'a path resolves by basename')
assert.equal(infer('  FOO=1 BAR=two codex --yolo'), 'codex', 'leading env assignments are skipped')
assert.equal(infer('"claude" --verbose'), 'claude', 'surrounding quotes are ignored')
assert.equal(infer(['/opt/bin/codex', '--yolo']), 'codex', 'argv form uses the first element')
assert.equal(infer(['C:\\tools\\claude.exe']), 'claude', 'Windows paths and extensions resolve')
assert.equal(runtimeWarnings.length, 0, 'known binaries never warn')
// Unknown binaries keep claude: wrapper scripts that forward to claude depend on its flags.
assert.equal(infer('aider --yes'), 'claude')
assert.equal(infer(['node', 'agent.js']), 'claude')
assert.equal(infer('claude-wrapper.sh'), 'claude', 'only an exact binary name is recognised')
assert.equal(runtimeWarnings.length, 3, 'every unrecognised binary warns')
assert.match(runtimeWarnings[0], /aider --yes/, 'the warning names the command')
assert.match(runtimeWarnings[0], /not a recognised runtime/)
assert.match(runtimeWarnings[0], /"runtime": "raw"/, 'the warning says how to opt out')
assert.equal(commandBinary('A=1'), null)
assert.equal(commandBinary(''), null)
// The adapters inference picks never append another vendor's flags.
assert.deepEqual(getRuntime(infer('codex --yolo')).buildArgs({ baseArgs: ['--yolo'], prompt: 'p' }), ['exec', '--yolo', '--json', 'p'])
assert.deepEqual(getRuntime('raw').buildArgs({ baseArgs: ['--yes'], prompt: 'p' }), ['--yes'])

console.log('runtime inference tests passed')
