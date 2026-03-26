// Run: node assets/build-icon.mjs
// Requires: npm install sharp (already a devDep)
// Input: assets/Icon-iOS-Dark-1024x1024@1x.png (or any 1024x1024 PNG)
// Output: assets/icon.png + assets/icon.icns + replaces Electron bundle icon

import sharp from 'sharp'
import { execSync } from 'child_process'
import { mkdirSync, copyFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const src = path.join(__dirname, 'Icon-iOS-Dark-1024x1024@1x.png')
const iconPng = path.join(__dirname, 'icon.png')
const iconicns = path.join(__dirname, 'icon.icns')
const iconset = '/tmp/taskos.iconset'

// Add macOS-standard padding (82% artwork, 9% padding each side)
const artworkSize = Math.round(1024 * 0.82)
const pad = Math.round((1024 - artworkSize) / 2)

await sharp(src)
  .resize(artworkSize, artworkSize)
  .extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png()
  .toFile(iconPng)

console.log(`✓ icon.png (${artworkSize}px artwork, ${pad}px padding)`)

// Build .icns
mkdirSync(iconset, { recursive: true })
for (const size of [16, 32, 64, 128, 256, 512]) {
  execSync(`sips -z ${size} ${size} "${iconPng}" --out "${iconset}/icon_${size}x${size}.png" 2>/dev/null`)
}
copyFileSync(`${iconset}/icon_32x32.png`,  `${iconset}/icon_16x16@2x.png`)
copyFileSync(`${iconset}/icon_64x64.png`,  `${iconset}/icon_32x32@2x.png`)
copyFileSync(`${iconset}/icon_256x256.png`, `${iconset}/icon_128x128@2x.png`)
copyFileSync(`${iconset}/icon_512x512.png`, `${iconset}/icon_256x256@2x.png`)
execSync(`iconutil -c icns "${iconset}" -o "${iconicns}"`)
console.log('✓ icon.icns')

// Replace Electron dev bundle icon
const electronIcon = path.join(__dirname, '../node_modules/electron/dist/Electron.app/Contents/Resources/electron.icns')
copyFileSync(iconicns, electronIcon)
console.log('✓ Electron bundle icon replaced')
console.log('\nRestart Electron to see the new icon.')
