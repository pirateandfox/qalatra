#!/usr/bin/env node
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const NATIVE_MODULES = ['better-sqlite3', 'node-pty']

function removeBuildDir(moduleName) {
  const buildDir = path.join(ROOT, 'node_modules', moduleName, 'build')
  fs.rmSync(buildDir, { recursive: true, force: true })
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: false,
    ...options,
  })
  if (result.error) {
    console.error(result.error.message)
    process.exit(1)
  }
  if (result.status !== 0) process.exit(result.status || 1)
}

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const env = {
  ...process.env,
  npm_config_runtime: 'node',
  npm_config_target: process.versions.node,
  npm_config_disturl: 'https://nodejs.org/download/release',
  npm_config_build_from_source: 'true',
}

delete env.npm_config_electron_version
delete env.npm_config_target_framework

for (const moduleName of NATIVE_MODULES) {
  removeBuildDir(moduleName)
}

run(npmCommand, ['rebuild', ...NATIVE_MODULES, '--build-from-source'], { env })
run(process.execPath, ['-e', `
  require('better-sqlite3')
  require('node-pty')
  console.log('Native modules OK for Node ' + process.version + ' ABI ' + process.versions.modules)
`], { env })
