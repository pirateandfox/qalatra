import assert from 'node:assert/strict'
import {
  commandDiagnosticLines,
  replaceShellPlaceholder,
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

console.log('worker command-template tests passed')
