/**
 * 构建后的 JS chunk 体积（gzip）。
 * 首屏 = 入口静态依赖，加上登录后第一个可见页（订单池、特单）各自再拉的动态 chunk。
 * 用法：node scripts/chunk-report.mjs [--check]
 */
import { gzipSync } from 'node:zlib'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dist = path.join(root, 'dist')
const assetsDir = path.join(dist, 'assets')
const check = process.argv.includes('--check')
const LIMIT = 250 * 1024

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

const files = walk(dist).filter((file) => file.endsWith('.js') || file.endsWith('.css') || file.endsWith('.map'))
const jsFiles = files.filter((file) => file.endsWith('.js'))
const byName = new Map()
for (const file of jsFiles) {
  const raw = readFileSync(file)
  const name = path.relative(dist, file)
  byName.set(name, { name, raw: raw.length, gzip: gzipSync(raw).length, text: raw.toString('utf8') })
}

function importsOf(text) {
  const found = new Set()
  for (const match of text.matchAll(/from\s*"(\.\/[^"]+\.js)"|import\s*"(\.\/[^"]+\.js)"|import\(\s*"(\.\/[^"]+\.js)"\s*\)/g)) {
    const spec = match[1] || match[2] || match[3]
    const base = path.posix.normalize(path.posix.join('assets', spec.replace(/^\.\//, '')))
    found.add(base)
  }
  return found
}

function staticImports(text) {
  const found = new Set()
  for (const match of text.matchAll(/(?:from|import)"(\.\/[^"]+\.js)"/g)) {
    found.add(path.posix.normalize(path.posix.join('assets', match[1].replace(/^\.\//, ''))))
  }
  return found
}

function dynamicImports(text) {
  const found = new Set()
  for (const match of text.matchAll(/import\(\s*"(\.\/[^"]+\.js)"\s*\)/g)) {
    found.add(path.posix.normalize(path.posix.join('assets', match[1].replace(/^\.\//, ''))))
  }
  return found
}

function closure(start, nextOf) {
  const seen = new Set()
  const queue = [...start]
  while (queue.length) {
    const name = queue.pop()
    if (!name || seen.has(name)) continue
    const item = byName.get(name)
    if (!item) continue
    seen.add(name)
    for (const dep of nextOf(item.text)) queue.push(dep)
  }
  return seen
}

const indexHtml = readFileSync(path.join(dist, 'index.html'), 'utf8')
const entry = [...indexHtml.matchAll(/src="\/(assets\/[^"]+\.js)"/g)].map((m) => m[1])
const preload = [...indexHtml.matchAll(/href="\/(assets\/[^"]+\.js)"/g)].map((m) => m[1])

const login = closure(new Set([...entry, ...preload]), staticImports)

function chunkNamed(baseName) {
  const hits = [...byName.keys()].filter((name) => name.includes(`/${baseName}-`))
  if (hits.length !== 1) {
    console.error(`expected one chunk named ${baseName}, got ${hits.join(', ') || '(none)'}`)
    process.exit(1)
  }
  return hits[0]
}

function screen(label, pageName) {
  const set = new Set(login)
  const shell = chunkNamed('Shell')
  const page = chunkNamed(pageName)
  for (const name of closure(new Set([shell, page]), staticImports)) set.add(name)
  const rows = [...set].map((name) => byName.get(name)).filter(Boolean).sort((a, b) => b.gzip - a.gzip)
  const gzip = rows.reduce((sum, row) => sum + row.gzip, 0)
  return { label, gzip, rows }
}

console.log('chunk gzip report')
const rows = [...byName.values()].sort((a, b) => b.gzip - a.gzip)
for (const row of rows) {
  console.log(`${(row.gzip / 1024).toFixed(1).padStart(8)} KB gzip  ${(row.raw / 1024).toFixed(1).padStart(8)} KB  ${row.name}`)
}
const maps = files.filter((file) => file.endsWith('.map'))
console.log(`sourcemap files: ${maps.length}`)

const forbidden = []
for (const row of rows) {
  if (row.text.includes('mock-token-owner')) forbidden.push(`${row.name} contains mock-token-owner`)
  if (row.text.includes('sourcesContent')) forbidden.push(`${row.name} contains sourcesContent`)
}
if (maps.length) forbidden.push(`${maps.length} sourcemap files in dist`)
if (forbidden.length) {
  console.error('bundle contamination:')
  for (const item of forbidden) console.error(`  ${item}`)
  process.exit(1)
}

const owner = screen('owner/clerk/warehouse first page /orders', 'OrdersPage')
const rep = screen('rep first page /special-orders', 'SpecialOrdersPage')

function printScreen(screenRow) {
  console.log(`\n${screenRow.label}: ${(screenRow.gzip / 1024).toFixed(1)} KB gzip`)
  for (const row of screenRow.rows) console.log(`  ${(row.gzip / 1024).toFixed(1).padStart(7)} KB  ${row.name}`)
}
printScreen(owner)
printScreen(rep)

const worst = Math.max(owner.gzip, rep.gzip)
if (check && worst > LIMIT) {
  console.error(`first screen ${ (worst / 1024).toFixed(1) } KB gzip exceeds ${LIMIT / 1024} KB`)
  process.exit(1)
}
console.log(`\nfirst-screen max ${(worst / 1024).toFixed(1)} KB gzip (limit ${LIMIT / 1024} KB)`)
