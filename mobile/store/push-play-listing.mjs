#!/usr/bin/env node
// Pushes the Google Play store listing (en-US text, icon, feature graphic, phone screenshots)
// through the Android Publisher API, using the same service account as `eas submit`.
//
//   node mobile/store/push-play-listing.mjs            # dry run: prints what would change
//   node mobile/store/push-play-listing.mjs --commit   # applies it
//
// Text comes from LISTING.md; images from play/. The service account needs "Manage store presence"
// in Play Console → Users and permissions. No dependencies: signs the OAuth JWT with node:crypto.
import { createSign } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const PACKAGE = 'com.qalatra.app'
const LANG = 'en-US'
const KEY_PATH = process.env.PLAY_KEY_FILE || join(homedir(), '.secrets/qalatra-play.json')
const commit = process.argv.includes('--commit')

function listing() {
  const md = readFileSync(join(here, 'LISTING.md'), 'utf8')
  const field = label => md.match(new RegExp(`- ${label}[^:]*: \`([^\`]+)\``))?.[1]
  const fullDescription = md.split('## Full description')[1]?.match(/```\n([\s\S]*?)\n```/)?.[1]
  const out = {
    language: LANG,
    title: field('Title'),
    shortDescription: field('Short description'),
    fullDescription,
  }
  for (const [k, v] of Object.entries(out)) if (!v) throw new Error(`LISTING.md is missing ${k}`)
  return out
}

async function accessToken() {
  const key = JSON.parse(readFileSync(KEY_PATH, 'utf8'))
  const now = Math.floor(Date.now() / 1000)
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url')
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/androidpublisher',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })}`
  const sig = createSign('RSA-SHA256').update(unsigned).sign(key.private_key, 'base64url')
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${sig}`,
    }),
  })
  const json = await res.json()
  if (!json.access_token) throw new Error(`OAuth failed: ${json.error_description || json.error}`)
  return json.access_token
}

const API = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE}`
const UPLOAD = `https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/${PACKAGE}`

async function call(token, method, url, body, contentType = 'application/json') {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': contentType } : {}) },
    body: body && contentType === 'application/json' ? JSON.stringify(body) : body,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${url.replace(API, '').replace(UPLOAD, '')}: ${res.status} ${text}`)
  return text ? JSON.parse(text) : {}
}

const images = [
  ['icon', join(here, 'play/icon-512.png')],
  ['featureGraphic', join(here, 'play/feature-graphic-1024x500.png')],
  ...readdirSync(join(here, 'play/phone'), { withFileTypes: true })
    .filter(f => f.isFile() && f.name.endsWith('.png'))
    .map(f => ['phoneScreenshots', join(here, 'play/phone', f.name)])
    .sort((a, b) => a[1].localeCompare(b[1])),
].filter(([, p]) => existsSync(p))

const text = listing()
console.log(`Listing (${LANG}): title "${text.title}", short ${text.shortDescription.length} chars, full ${text.fullDescription.length} chars`)
for (const [type, p] of images) console.log(`  ${type}: ${p.replace(here + '/', '')}`)
if (!commit) {
  console.log('\nDry run. Re-run with --commit to apply.')
  process.exit(0)
}

const token = await accessToken()
const { id: edit } = await call(token, 'POST', `${API}/edits`)
try {
  await call(token, 'PUT', `${API}/edits/${edit}/listings/${LANG}`, text)
  await call(token, 'PATCH', `${API}/edits/${edit}/details`, {
    contactEmail: 'support@qalatra.com',
    contactWebsite: 'https://qalatra.com',
    defaultLanguage: LANG,
  })
  for (const type of new Set(images.map(([t]) => t))) {
    await call(token, 'DELETE', `${API}/edits/${edit}/listings/${LANG}/${type}`)
  }
  for (const [type, p] of images) {
    await call(token, 'POST', `${UPLOAD}/edits/${edit}/listings/${LANG}/${type}?uploadType=media`, readFileSync(p), 'image/png')
  }
  await call(token, 'POST', `${API}/edits/${edit}:commit`)
  console.log('Committed.')
} catch (e) {
  await call(token, 'DELETE', `${API}/edits/${edit}`).catch(() => {})
  throw e
}
