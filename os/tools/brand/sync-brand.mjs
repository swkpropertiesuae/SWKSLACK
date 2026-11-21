// Pulls the official SWK brand assets from the company website into this app.
//   npm run brand:sync                                    # from https://www.swkpropertiesuae.com
//   BRAND_SOURCE=../swkpropertiesuae.com/public npm run brand:sync   # from a local website checkout
// The website (swkpropertiesuae.com) is the single source of truth; this app keeps committed copies so
// the OS, PDFs and the offline PWA never depend on the website being reachable at runtime.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const SOURCE = (process.env.BRAND_SOURCE || 'https://www.swkpropertiesuae.com').replace(/\/$/, '')
const isUrl = /^https?:\/\//.test(SOURCE)
const root = path.resolve(import.meta.dirname, '../..')

const BRAND = ['swk-emblem.svg', 'swk-emblem-charcoal.svg', 'swk-emblem-2048.png', 'swk-emblem-charcoal-1024.png', 'swk-emblem-charcoal-2048.png',
  'swk-logo-horizontal.svg', 'swk-logo-horizontal-charcoal.svg', 'swk-logo-horizontal-4096.png', 'swk-logo-horizontal-charcoal-4096.png',
  'swk-logo-stacked.svg', 'swk-logo-stacked-charcoal.svg', 'swk-logo-stacked-4096.png', 'swk-logo-stacked-charcoal-4096.png',
  'swk-wordmark.svg', 'swk-wordmark-charcoal.svg']
const FAVICONS = ['favicon.svg', 'favicon-16.svg', 'favicon-16.png', 'favicon-32.png', 'favicon-48.png', 'favicon-96.png', 'favicon-192.png', 'favicon-512.png', 'apple-touch-icon.png', 'favicon.ico']
const COMMUNITIES = ['business-bay', 'downtown-dubai', 'dubai-creek-harbour', 'dubai-hills-estate', 'dubai-marina', 'jvc', 'palm-jumeirah', 'sheikh-zayed-road']

/** [path on the website, path inside this repo's public/] */
const MAP = [
  ...BRAND.map(f => [`brand/${f}`, `brand/site/${f}`]),
  ...FAVICONS.map(f => [f, `favicon/${f}`]),
  ['favicon.ico', 'favicon.ico'],
  ['app-icon-512.png', 'app-icon-512.png'],
  ['og-default.jpg', 'brand/site/og-default.jpg'],
  ['img/hero/dubai-skyline-hero.webp', 'media/hero/dubai-skyline-hero.webp'],
  ...COMMUNITIES.flatMap(c => [`${c}.webp`, `${c}-640.webp`].map(f => [`img/communities/${f}`, `media/communities/${f}`])),
]

const read = async (rel) => {
  if (!isUrl) return fs.readFileSync(path.resolve(SOURCE, rel))
  const r = await fetch(`${SOURCE}/${rel}`)
  if (!r.ok) throw new Error(`${r.status} ${SOURCE}/${rel}`)
  return Buffer.from(await r.arrayBuffer())
}

const manifest = {}
for (const [from, to] of MAP) {
  const buf = await read(from)
  const dest = path.join(root, 'public', to)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, buf)
  manifest[to] = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16)
}
fs.writeFileSync(path.join(root, 'public/brand/site/SOURCE.json'),
  JSON.stringify({ source: isUrl ? SOURCE : 'local checkout of swkpropertiesuae.com', files: manifest }, null, 2) + '\n')
console.log(`brand:sync ${MAP.length} files from ${SOURCE}`)
