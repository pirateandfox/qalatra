// Box-role gate (bugs C2/C5).
//
// Duty-executing background workers (agent-job processing, autorun, heartbeats) must run on
// exactly ONE canonical box. Previously there was no gate at all and the Electron/dev launch
// paths even hard-forced QALATRA_START_WORKERS=1, so a second instance (e.g. a laptop pointed
// at a stale copy of the canonical data) would fire scheduled duties with real external side
// effects on the wrong box.
//
// Mechanism: an optional role file at ~/.config/qalatra/box-role names the box that is allowed
// to run duties. A box runs duties only when its own identity matches that name. When no role
// file (and no QALATRA_BOX_ROLE) is configured — the ordinary single-box install — the historic
// default (workers on) is preserved so normal users are unaffected. Multi-box operators drop a
// role file naming the canonical box on EVERY box; only the box whose hostname matches runs.

import fs from 'fs'
import os from 'os'
import path from 'path'

export function boxRoleFilePath() {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  return path.join(configHome, 'qalatra', 'box-role')
}

// The role this box has been told to require, or null if none configured.
// QALATRA_BOX_ROLE (env) wins over the role file.
export function readConfiguredRole({ env = process.env, filePath = boxRoleFilePath() } = {}) {
  const fromEnv = env.QALATRA_BOX_ROLE
  if (fromEnv && fromEnv.trim()) return fromEnv.trim()
  try {
    const v = fs.readFileSync(filePath, 'utf8').trim()
    return v || null
  } catch {
    return null
  }
}

// This box's own identity. QALATRA_BOX_HOSTNAME overrides the detected hostname (testing / FQDN).
export function thisBoxIdentity({ env = process.env, hostname } = {}) {
  const override = env.QALATRA_BOX_HOSTNAME
  if (override && override.trim()) return override.trim()
  return (hostname ?? os.hostname() ?? '').trim()
}

// Pure decision — safe to unit test. `role`/`identity` may be injected; otherwise resolved from
// env + role file + hostname.
export function shouldRunDutyWorkers({ env = process.env, role, identity } = {}) {
  if (env.QALATRA_START_WORKERS === '0') {
    return { run: false, reason: 'QALATRA_START_WORKERS=0 (explicitly disabled)' }
  }
  const configuredRole = role !== undefined ? role : readConfiguredRole({ env })
  if (!configuredRole) {
    return { run: true, reason: 'no box-role configured (single-box default: workers on)' }
  }
  const me = identity !== undefined ? identity : thisBoxIdentity({ env })
  if (me && configuredRole === me) {
    return { run: true, reason: `box-role '${configuredRole}' matches this box` }
  }
  return {
    run: false,
    reason: `box-role '${configuredRole}' does not match this box '${me || '(unknown)'}' — not the canonical worker box`,
  }
}
