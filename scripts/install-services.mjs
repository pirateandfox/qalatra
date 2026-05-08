// install-services.mjs — installs/updates the Qalatra MCP launchd service on macOS.
// Called by Electron on first launch and after each update (production only).
// Dev mode uses a plain child_process instead — this file is not involved.

import { execSync, execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import os from 'os'

const LABEL = 'com.qalatra.mcp'
const PLIST_PATH = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`)
const LOG_DIR = path.join(os.homedir(), 'Library', 'Logs', 'Qalatra')

function getUid() {
  try { return process.getuid() } catch { return execSync('id -u', { encoding: 'utf8' }).trim() }
}

function resolveNodePath() {
  // Run node in a shell so PATH/asdf/nvm are all active, then return the real binary.
  try {
    return execSync('node -e "process.stdout.write(process.execPath)"', { encoding: 'utf8' }).trim()
  } catch {
    // Fallback search locations
    for (const p of ['/usr/local/bin/node', '/opt/homebrew/bin/node', '/usr/bin/node']) {
      if (fs.existsSync(p)) return p
    }
    throw new Error('Cannot find node binary — install Node.js before running Qalatra')
  }
}

function buildPlist({ nodePath, serverPath, dbDir, settingsFile }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${serverPath}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>TASKOS_DB_DIR</key>
    <string>${dbDir}</string>
    <key>TASKOS_SETTINGS_FILE</key>
    <string>${settingsFile}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>Crashed</key>
    <true/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>${LOG_DIR}/mcp.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/mcp-error.log</string>
</dict>
</plist>`
}

// Install or update the MCP launchd service.
// serverPath: absolute path to mcp/http-server-entry.cjs (inside app bundle in prod)
// dbDir: path to the directory containing tasks.db and settings.json
export function installMcpService({ serverPath, dbDir }) {
  if (process.platform !== 'darwin') {
    console.log('[services] launchd install skipped — not macOS')
    return
  }

  fs.mkdirSync(LOG_DIR, { recursive: true })
  fs.mkdirSync(path.dirname(PLIST_PATH), { recursive: true })

  const nodePath = resolveNodePath()
  const settingsFile = path.join(dbDir, 'settings.json')
  const plist = buildPlist({ nodePath, serverPath, dbDir, settingsFile })

  const existing = fs.existsSync(PLIST_PATH) ? fs.readFileSync(PLIST_PATH, 'utf8') : ''
  if (existing === plist) {
    console.log('[services] MCP service plist unchanged')
    return
  }

  console.log('[services] installing/updating MCP launchd service')
  const uid = getUid()

  // Unload existing service if loaded
  try { execFileSync('launchctl', ['bootout', `gui/${uid}/${LABEL}`]) } catch {}

  fs.writeFileSync(PLIST_PATH, plist, 'utf8')

  // Load the new service
  try {
    execFileSync('launchctl', ['bootstrap', `gui/${uid}`, PLIST_PATH])
    console.log('[services] MCP service loaded')
  } catch (e) {
    console.error('[services] failed to load MCP service:', e.message)
  }
}

// Remove the MCP launchd service (used when uninstalling or switching to dev mode).
export function uninstallMcpService() {
  if (process.platform !== 'darwin') return
  const uid = getUid()
  try { execFileSync('launchctl', ['bootout', `gui/${uid}/${LABEL}`]) } catch {}
  try { fs.unlinkSync(PLIST_PATH) } catch {}
  console.log('[services] MCP service removed')
}
