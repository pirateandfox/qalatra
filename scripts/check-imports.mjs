#!/usr/bin/env node
/**
 * Pre-build guard: walks all relative imports from Electron entry points and
 * verifies (1) the file exists on disk and (2) it's covered by the files list
 * in electron-builder.yml. Fails with a clear message so CI catches this
 * before an expensive build+notarize cycle.
 */

import { readFileSync, existsSync } from 'fs'
import { resolve, dirname, relative, join } from 'path'
import { fileURLToPath } from 'url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// Entry points that Electron loads directly (not through the UI bundle)
const ENTRY_POINTS = [
  'electron-main.js',
  'ipc-handlers.js',
  'db-worker.js',
  's3.js',
]

// ── Parse electron-builder.yml files list ────────────────────────────────────

function parseBuilderPatterns() {
  const yml = readFileSync(join(ROOT, 'electron-builder.yml'), 'utf8')
  const match = yml.match(/^files:\n((?:[ \t]+-[ \t]+.+\n)+)/m)
  if (!match) throw new Error('Cannot parse "files:" section from electron-builder.yml')
  return match[1]
    .split('\n')
    .filter(l => /^\s+-/.test(l))
    .map(l => l.replace(/^\s+-\s+/, '').replace(/^["']|["']$/g, '').trim())
    .filter(Boolean)
}

// ── Minimal glob matcher (handles the patterns we actually use) ───────────────

function globToRegex(pattern) {
  const esc = pattern
    .replace(/\./g, '\\.')           // escape dots first
    .replace(/\*\*\/\*/g, '\x00')   // **/* → placeholder (match anything)
    .replace(/\*\*\//g, '\x01')     // **/ → placeholder (optional path prefix)
    .replace(/\*/g, '[^/]*')        // * → any segment chars
    .replace(/\x00/g, '.+')         // **/* → .+
    .replace(/\x01/g, '(?:.+/)?')   // **/ → optional prefix
  return new RegExp(`^${esc}$`)
}

function isIncluded(relPath, patterns) {
  const pos = patterns.filter(p => !p.startsWith('!')).map(globToRegex)
  const neg = patterns.filter(p => p.startsWith('!')).map(p => globToRegex(p.slice(1)))
  return pos.some(re => re.test(relPath)) && !neg.some(re => re.test(relPath))
}

// ── Walk relative imports ─────────────────────────────────────────────────────

const visited = new Set()
const discovered = new Map() // relPath → imported-from relPath

function walk(absPath) {
  if (visited.has(absPath)) return
  visited.add(absPath)
  if (!existsSync(absPath)) return

  const content = readFileSync(absPath, 'utf8')
  const re = /from\s+['"](\.[^'"]+)['"]/g
  let m
  while ((m = re.exec(content)) !== null) {
    let resolved = resolve(dirname(absPath), m[1])
    if (!existsSync(resolved) && existsSync(resolved + '.js')) resolved += '.js'
    const rel = relative(ROOT, resolved)
    if (!discovered.has(rel)) {
      discovered.set(rel, relative(ROOT, absPath))
    }
    walk(resolved)
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

const patterns = parseBuilderPatterns()
let errors = 0

for (const entry of ENTRY_POINTS) {
  walk(join(ROOT, entry))
}

for (const [rel, importedFrom] of discovered) {
  const abs = join(ROOT, rel)

  if (!existsSync(abs)) {
    console.error(`\n✕  FILE MISSING: ${rel}`)
    console.error(`   imported from: ${importedFrom}`)
    errors++
    continue
  }

  if (!isIncluded(rel, patterns)) {
    console.error(`\n✕  NOT IN BUNDLE: ${rel}`)
    console.error(`   imported from: ${importedFrom}`)
    console.error(`   Fix: add it to the "files:" list in electron-builder.yml`)
    errors++
  }
}

if (errors === 0) {
  console.log(`✓  check-imports passed — ${discovered.size} local file(s) verified`)
  process.exit(0)
} else {
  console.error(`\n${errors} problem(s) found. Fix before building.`)
  process.exit(1)
}
