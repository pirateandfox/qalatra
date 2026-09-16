import assert from 'node:assert/strict'
import {
  argvCommandError,
  buildSystemdAgentLauncher,
  commandDiagnosticLines,
  commandHasPlaceholder,
  isArgvCommand,
  replaceShellPlaceholder,
  resolveArgvTemplate,
  resumeMessageForJob,
  templateEnv,
} from '../server/workers.js'

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
