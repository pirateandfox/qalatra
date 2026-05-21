import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'

const MAC_LABEL = 'com.qalatra.server'
const LINUX_SERVICE = 'qalatra-server.service'
const WINDOWS_TASK = 'Qalatra Server'

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options })
}

function tryRun(command, args, options = {}) {
  try {
    return { ok: true, stdout: run(command, args, options), error: null }
  } catch (e) {
    return {
      ok: false,
      stdout: e.stdout?.toString?.() ?? '',
      error: e.stderr?.toString?.().trim() || e.message,
    }
  }
}

function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function quoteSystemd(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

function quotePowerShell(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

function serviceEnv(options) {
  return {
    NODE_ENV: 'production',
    ...(options.useElectronRunAsNode ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    QALATRA_DATA_DIR: options.dataDir,
    QALATRA_API_HOST: options.apiHost || '127.0.0.1',
    QALATRA_API_PORT: String(options.apiPort || 3456),
    QALATRA_MCP_HOST: options.mcpHost || '127.0.0.1',
    QALATRA_START_MCP: options.startMcp === false ? '0' : '1',
    QALATRA_START_WORKERS: options.startWorkers === false ? '0' : '1',
    QALATRA_BOOTSTRAP_TOKEN_FILE: '1',
  }
}

function serviceCommand(options) {
  return {
    runtime: options.runtimePath,
    args: [options.serverPath],
    cwd: options.workingDir || path.dirname(options.serverPath),
    env: serviceEnv(options),
  }
}

function macTarget() {
  const uid = process.getuid ? process.getuid() : run('id', ['-u']).trim()
  return `gui/${uid}/${MAC_LABEL}`
}

function macPlistPath() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${MAC_LABEL}.plist`)
}

function macLogDir() {
  return path.join(os.homedir(), 'Library', 'Logs', 'Qalatra')
}

function macPlist(options) {
  const command = serviceCommand(options)
  const envXml = Object.entries(command.env)
    .map(([key, value]) => `    <key>${xmlEscape(key)}</key><string>${xmlEscape(value)}</string>`)
    .join('\n')
  const argsXml = [command.runtime, ...command.args]
    .map(arg => `    <string>${xmlEscape(arg)}</string>`)
    .join('\n')
  const logDir = macLogDir()

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${MAC_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argsXml}
  </array>
  <key>WorkingDirectory</key><string>${xmlEscape(command.cwd)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>Crashed</key><true/></dict>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>${xmlEscape(path.join(logDir, 'server.log'))}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(path.join(logDir, 'server-error.log'))}</string>
</dict>
</plist>`
}

function linuxServicePath() {
  return path.join(os.homedir(), '.config', 'systemd', 'user', LINUX_SERVICE)
}

function linuxUnit(options) {
  const command = serviceCommand(options)
  const envLines = Object.entries(command.env)
    .map(([key, value]) => `Environment=${quoteSystemd(`${key}=${value}`)}`)
    .join('\n')
  const execStart = [command.runtime, ...command.args].map(quoteSystemd).join(' ')

  return `[Unit]
Description=Qalatra Server
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${quoteSystemd(command.cwd)}
${envLines}
ExecStart=${execStart}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`
}

function windowsScriptPath(options) {
  return path.join(options.dataDir, 'qalatra-server-service.ps1')
}

function windowsScript(options) {
  const command = serviceCommand(options)
  const envLines = Object.entries(command.env)
    .map(([key, value]) => `$env:${key} = ${quotePowerShell(value)}`)
    .join('\n')
  const args = command.args.map(quotePowerShell).join(', ')
  return `$ErrorActionPreference = 'Stop'
Set-Location ${quotePowerShell(command.cwd)}
${envLines}
& ${quotePowerShell(command.runtime)} ${args}
`
}

function windowsTaskCommand(options) {
  const scriptPath = windowsScriptPath(options)
  return `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${scriptPath}"`
}

export function getServiceDescriptor(options = {}) {
  const platform = options.platform || process.platform
  if (platform === 'darwin') {
    return {
      platform,
      kind: 'launchd',
      name: MAC_LABEL,
      label: 'macOS LaunchAgent',
      file: macPlistPath(),
      supportsAutostart: true,
    }
  }
  if (platform === 'linux') {
    return {
      platform,
      kind: 'systemd-user',
      name: LINUX_SERVICE,
      label: 'Linux systemd user service',
      file: linuxServicePath(),
      supportsAutostart: true,
    }
  }
  if (platform === 'win32') {
    return {
      platform,
      kind: 'scheduled-task',
      name: WINDOWS_TASK,
      label: 'Windows logon Scheduled Task',
      file: options.dataDir ? windowsScriptPath(options) : null,
      supportsAutostart: true,
    }
  }
  return {
    platform,
    kind: 'unsupported',
    name: null,
    label: 'Unsupported platform',
    file: null,
    supportsAutostart: false,
  }
}

export function getServiceStatus(options = {}) {
  const descriptor = getServiceDescriptor(options)
  if (descriptor.kind === 'unsupported') {
    return { ...descriptor, supported: false, installed: false, running: false, enabled: false }
  }

  if (descriptor.kind === 'launchd') {
    const installed = fs.existsSync(descriptor.file)
    const printed = tryRun('launchctl', ['print', macTarget()])
    const running = printed.ok && /\bpid\s*=\s*\d+/.test(printed.stdout)
    return { ...descriptor, supported: true, installed, running, enabled: installed, error: printed.ok || !installed ? null : printed.error }
  }

  if (descriptor.kind === 'systemd-user') {
    const installed = fs.existsSync(descriptor.file)
    const enabled = tryRun('systemctl', ['--user', 'is-enabled', LINUX_SERVICE]).stdout.trim() === 'enabled'
    const running = tryRun('systemctl', ['--user', 'is-active', LINUX_SERVICE]).stdout.trim() === 'active'
    return { ...descriptor, supported: true, installed, running, enabled }
  }

  if (descriptor.kind === 'scheduled-task') {
    const queried = tryRun('schtasks.exe', ['/Query', '/TN', WINDOWS_TASK, '/FO', 'LIST', '/V'])
    const installed = queried.ok
    const running = installed && /^Status:\s*Running$/mi.test(queried.stdout)
    const ready = installed && /^Status:\s*Ready$/mi.test(queried.stdout)
    return { ...descriptor, supported: true, installed, running, enabled: installed && (running || ready), error: installed ? null : queried.error }
  }

  return { ...descriptor, supported: false, installed: false, running: false, enabled: false }
}

export function installService(options) {
  const descriptor = getServiceDescriptor(options)
  if (!descriptor.supportsAutostart) return { ok: false, error: `Unsupported platform: ${descriptor.platform}` }

  fs.mkdirSync(options.dataDir, { recursive: true })

  if (descriptor.kind === 'launchd') {
    fs.mkdirSync(path.dirname(descriptor.file), { recursive: true })
    fs.mkdirSync(macLogDir(), { recursive: true })
    fs.writeFileSync(descriptor.file, macPlist(options), 'utf8')
    tryRun('launchctl', ['bootout', macTarget()])
    const loaded = tryRun('launchctl', ['bootstrap', `gui/${process.getuid()}`, descriptor.file])
    if (!loaded.ok) return { ok: false, error: loaded.error }
    tryRun('launchctl', ['enable', macTarget()])
    const started = tryRun('launchctl', ['kickstart', '-k', macTarget()])
    if (!started.ok) return { ok: false, error: started.error }
    return { ok: true, status: getServiceStatus(options) }
  }

  if (descriptor.kind === 'systemd-user') {
    fs.mkdirSync(path.dirname(descriptor.file), { recursive: true })
    fs.writeFileSync(descriptor.file, linuxUnit(options), 'utf8')
    const reloaded = tryRun('systemctl', ['--user', 'daemon-reload'])
    if (!reloaded.ok) return { ok: false, error: reloaded.error }
    const enabled = tryRun('systemctl', ['--user', 'enable', '--now', LINUX_SERVICE])
    if (!enabled.ok) return { ok: false, error: enabled.error }
    return { ok: true, status: getServiceStatus(options) }
  }

  if (descriptor.kind === 'scheduled-task') {
    fs.writeFileSync(windowsScriptPath(options), windowsScript(options), 'utf8')
    const created = tryRun('schtasks.exe', [
      '/Create',
      '/TN', WINDOWS_TASK,
      '/SC', 'ONLOGON',
      '/TR', windowsTaskCommand(options),
      '/RL', 'LIMITED',
      '/F',
    ])
    if (!created.ok) return { ok: false, error: created.error }
    tryRun('schtasks.exe', ['/Run', '/TN', WINDOWS_TASK])
    return { ok: true, status: getServiceStatus(options) }
  }

  return { ok: false, error: 'Unsupported service kind' }
}

export function uninstallService(options) {
  const descriptor = getServiceDescriptor(options)
  if (!descriptor.supportsAutostart) return { ok: false, error: `Unsupported platform: ${descriptor.platform}` }

  if (descriptor.kind === 'launchd') {
    tryRun('launchctl', ['bootout', macTarget()])
    try { fs.unlinkSync(descriptor.file) } catch {}
    return { ok: true, status: getServiceStatus(options) }
  }

  if (descriptor.kind === 'systemd-user') {
    tryRun('systemctl', ['--user', 'disable', '--now', LINUX_SERVICE])
    try { fs.unlinkSync(descriptor.file) } catch {}
    tryRun('systemctl', ['--user', 'daemon-reload'])
    return { ok: true, status: getServiceStatus(options) }
  }

  if (descriptor.kind === 'scheduled-task') {
    tryRun('schtasks.exe', ['/End', '/TN', WINDOWS_TASK])
    tryRun('schtasks.exe', ['/Delete', '/TN', WINDOWS_TASK, '/F'])
    return { ok: true, status: getServiceStatus(options) }
  }

  return { ok: false, error: 'Unsupported service kind' }
}

export function startService(options) {
  const descriptor = getServiceDescriptor(options)
  if (descriptor.kind === 'launchd') {
    const current = tryRun('launchctl', ['print', macTarget()])
    if (!current.ok) {
      const loaded = tryRun('launchctl', ['bootstrap', `gui/${process.getuid()}`, descriptor.file])
      if (!loaded.ok) return { ok: false, error: loaded.error }
    }
    const started = tryRun('launchctl', ['kickstart', '-k', macTarget()])
    return started.ok ? { ok: true, status: getServiceStatus(options) } : { ok: false, error: started.error }
  }
  if (descriptor.kind === 'systemd-user') {
    const started = tryRun('systemctl', ['--user', 'start', LINUX_SERVICE])
    return started.ok ? { ok: true, status: getServiceStatus(options) } : { ok: false, error: started.error }
  }
  if (descriptor.kind === 'scheduled-task') {
    const started = tryRun('schtasks.exe', ['/Run', '/TN', WINDOWS_TASK])
    return started.ok ? { ok: true, status: getServiceStatus(options) } : { ok: false, error: started.error }
  }
  return { ok: false, error: `Unsupported platform: ${descriptor.platform}` }
}

export function stopService(options) {
  const descriptor = getServiceDescriptor(options)
  if (descriptor.kind === 'launchd') {
    const stopped = tryRun('launchctl', ['bootout', macTarget()])
    return stopped.ok || /No such process/i.test(stopped.error) ? { ok: true, status: getServiceStatus(options) } : { ok: false, error: stopped.error }
  }
  if (descriptor.kind === 'systemd-user') {
    const stopped = tryRun('systemctl', ['--user', 'stop', LINUX_SERVICE])
    return stopped.ok ? { ok: true, status: getServiceStatus(options) } : { ok: false, error: stopped.error }
  }
  if (descriptor.kind === 'scheduled-task') {
    const stopped = tryRun('schtasks.exe', ['/End', '/TN', WINDOWS_TASK])
    return stopped.ok || /not currently running/i.test(stopped.error) ? { ok: true, status: getServiceStatus(options) } : { ok: false, error: stopped.error }
  }
  return { ok: false, error: `Unsupported platform: ${descriptor.platform}` }
}

export function restartService(options) {
  const stopped = stopService(options)
  if (!stopped.ok) return stopped
  return startService(options)
}
