#!/usr/bin/env node
/**
 * Store icons and splash for the native containers, rendered from public/icon.svg with the
 * Playwright already used by the tests (no new dependency). Reproducible: node scripts/mobile/generate-assets.mjs
 *   mobile/assets/icon-1024.png            iOS App Store icon: 1024 × 1024, square, opaque (iOS applies the mask)
 *   mobile/assets/android-foreground-432.png  adaptive icon foreground (logo inside the 66 % safe zone, transparent)
 *   mobile/assets/android-background.txt   adaptive icon background colour
 *   mobile/assets/splash-2732.png          splash 2732 × 2732 (#070b14 with the centred mark)
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../..', import.meta.url))
const { chromium } = createRequire(import.meta.url)('playwright')
const svg = readFileSync(`${root}/public/icon.svg`, 'utf8')
const BG = '#070b14'
// square, opaque: the outer rounded background becomes a full square (store icons must not be pre-rounded / transparent)
const square = svg.replace(/<rect width="512" height="512" rx="\d+" fill="#070b14"\/>/, `<rect width="512" height="512" fill="${BG}"/>`)
// the mark alone (no outer background) for the adaptive foreground and the splash
const mark = svg.replace(/<rect width="512" height="512" rx="\d+" fill="#070b14"\/>/, '')
if (square === svg || mark === svg) throw new Error('icon.svg changed shape: update the generator')
mkdirSync(`${root}/mobile/assets`, { recursive: true })
const b64 = (s) => `data:image/svg+xml;base64,${Buffer.from(s).toString('base64')}`
const browser = await chromium.launch()
async function shot(file, size, html, transparent = false) {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 })
  await page.setContent(`<html><body style="margin:0;background:${transparent ? 'transparent' : BG}">${html}</body></html>`)
  await page.screenshot({ path: `${root}/mobile/assets/${file}`, omitBackground: transparent, clip: { x: 0, y: 0, width: size, height: size } })
  await page.close()
}
await shot('icon-1024.png', 1024, `<img src="${b64(square)}" width="1024" height="1024" style="display:block">`)
await shot('android-foreground-432.png', 432, `<img src="${b64(mark)}" width="288" height="288" style="display:block;position:absolute;left:72px;top:72px">`, true)
await shot('splash-2732.png', 2732, `<img src="${b64(mark)}" width="640" height="640" style="display:block;position:absolute;left:1046px;top:1046px">`)
writeFileSync(`${root}/mobile/assets/android-background.txt`, `${BG}\n`)
await browser.close()
console.log('ok: mobile/assets')
