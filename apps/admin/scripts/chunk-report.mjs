/**
 * 构建后的 JS chunk 体积（gzip）。
 * 静态图只含 import/export。首屏上限按浏览器真实请求：
 * 写入角色会话后打开 /，等到第一页渲染完、网络安静，把请求过的 js 用 gzipSync 加总。
 * 这样「挂上 React.lazy 就会立刻拉」的动态 chunk 也会进 --check。
 * 用法：node scripts/chunk-report.mjs [--check]
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { gzipSync } from 'node:zlib'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
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

const staticOwner = screen('static /orders', 'OrdersPage')
const staticRep = screen('static /special-orders', 'SpecialOrdersPage')

function printScreen(screenRow) {
  console.log(`\n${screenRow.label}: ${screenRow.gzip} bytes (${(screenRow.gzip / 1024).toFixed(1)} KB gzip)`)
  for (const row of screenRow.rows) console.log(`  ${String(row.gzip).padStart(7)}  ${(row.gzip / 1024).toFixed(1).padStart(6)} KB  ${row.name}`)
}
printScreen(staticOwner)
printScreen(staticRep)

const ROLES = [
  { role: 'owner', name: '朱总', marker: '订单池', home: '/orders', staticSet: staticOwner },
  { role: 'clerk', name: '王内勤', marker: '订单池', home: '/orders', staticSet: staticOwner },
  { role: 'warehouse', name: '仓配张姐', marker: '订单池', home: '/orders', staticSet: staticOwner },
  { role: 'rep', name: '李业务员', marker: '特单', home: '/special-orders', staticSet: staticRep },
]

function startStaticServer() {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      let rel = decodeURIComponent(url.pathname)
      if (rel === '/') rel = '/index.html'
      const file = path.resolve(dist, `.${rel}`)
      if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory()) {
        res.writeHead(404)
        res.end('not found')
        return
      }
      const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8'
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' })
      res.end(readFileSync(file))
    })
    server.listen(0, '127.0.0.1', () => resolve(server))
    server.on('error', reject)
  })
}

async function chromeBase() {
  try {
    const res = await fetch('http://127.0.0.1:9222/json/version')
    if (res.ok) return { base: 'http://127.0.0.1:9222', child: null }
  } catch {
    // 没有现成的调试端口时再自己拉一个。
  }
  const userDir = `/tmp/admin-chunk-chrome-${process.pid}`
  const child = spawn('google-chrome', [
    '--headless=new',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--no-first-run',
    `--user-data-dir=${userDir}`,
    '--remote-debugging-port=9344',
    'about:blank',
  ], { stdio: 'ignore' })
  for (let i = 0; i < 50; i += 1) {
    try {
      const res = await fetch('http://127.0.0.1:9344/json/version')
      if (res.ok) return { base: 'http://127.0.0.1:9344', child }
    } catch {
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  child.kill()
  throw new Error('chrome did not open a debugging port')
}

function assetPath(raw) {
  try {
    const pathname = new URL(raw).pathname.replace(/^\//, '')
    if (pathname.startsWith('assets/') && pathname.endsWith('.js')) return pathname
  } catch {
    return null
  }
  return null
}

async function measureRole(cdpBase, origin, spec) {
  const created = await fetch(`${cdpBase}/json/new?about:blank`, { method: 'PUT' }).then((r) => r.json())
  const ws = new WebSocket(created.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  let nextId = 0
  const pending = new Map()
  const fetched = new Set()
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    const rawUrl = msg.params?.request?.url || msg.params?.response?.url
    const asset = rawUrl ? assetPath(rawUrl) : null
    if (asset) fetched.add(asset)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(JSON.stringify(msg.error)))
      else resolve(msg.result ?? {})
    }
  })
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
  try {
    await call('Network.enable')
    await call('Network.setCacheDisabled', { cacheDisabled: true })
    await call('Page.enable')
    const auth = JSON.stringify({ token: `measure-${spec.role}`, username: spec.role, name: spec.name, role: spec.role })
    await call('Page.addScriptToEvaluateOnNewDocument', {
      source: `localStorage.setItem('ld_admin_auth', ${JSON.stringify(auth)});`,
    })
    await call('Page.navigate', { url: `${origin}/?bust=${spec.role}` })
    const deadline = Date.now() + 20000
    let state = null
    while (Date.now() < deadline) {
      const result = await call('Runtime.evaluate', {
        expression: `(() => ({ path: location.pathname, text: (document.body && document.body.innerText || '').slice(0, 300), buttons: document.querySelectorAll('aside button').length }))()`,
        returnByValue: true,
      })
      state = result.result?.value
      if (state?.path === spec.home && state.buttons > 0 && state.text.includes(spec.marker) && !state.text.includes('页面加载中')) break
      await new Promise((r) => setTimeout(r, 150))
    }
    if (!state || state.path !== spec.home || !state.text.includes(spec.marker) || state.text.includes('页面加载中')) {
      throw new Error(`${spec.role} did not reach ${spec.home}: ${JSON.stringify(state)}`)
    }
    let stable = -1
    for (let i = 0; i < 8; i += 1) {
      await new Promise((r) => setTimeout(r, 200))
      const resources = await call('Runtime.evaluate', {
        expression: `performance.getEntriesByType('resource').map(e => e.name)`,
        returnByValue: true,
      })
      for (const name of resources.result?.value ?? []) {
        const asset = assetPath(name)
        if (asset) fetched.add(asset)
      }
      if (fetched.size === stable) break
      stable = fetched.size
    }
    const missing = [...fetched].filter((name) => !byName.has(name))
    if (missing.length) throw new Error(`unknown js: ${missing.join(', ')}`)
    const rows = [...fetched].map((name) => byName.get(name)).sort((a, b) => b.gzip - a.gzip)
    const gzip = rows.reduce((sum, row) => sum + row.gzip, 0)
    const staticNames = new Set(spec.staticSet.rows.map((row) => row.name))
    const extra = rows.filter((row) => !staticNames.has(row.name))
    return { role: spec.role, home: state.path, gzip, rows, extra }
  } finally {
    ws.close()
    await fetch(`${cdpBase}/json/close/${created.id}`).catch(() => {})
  }
}

const server = await startStaticServer()
const origin = `http://127.0.0.1:${server.address().port}`
const chrome = await chromeBase()
let worst = 0
try {
  console.log('\nbrowser first screen (gzipSync of requested js)')
  for (const spec of ROLES) {
    const measured = await measureRole(chrome.base, origin, spec)
    worst = Math.max(worst, measured.gzip)
    console.log(`\n${measured.role} ${measured.home}: ${measured.gzip} bytes (${(measured.gzip / 1024).toFixed(1)} KB gzip)`)
    for (const row of measured.rows) console.log(`  ${String(row.gzip).padStart(7)}  ${(row.gzip / 1024).toFixed(1).padStart(6)} KB  ${row.name}`)
    if (measured.extra.length) {
      const extraBytes = measured.extra.reduce((sum, row) => sum + row.gzip, 0)
      console.log(`  dynamic chunks fetched on first paint: ${extraBytes} bytes`)
      for (const row of measured.extra) console.log(`    ${row.name}`)
    } else {
      console.log('  dynamic chunks fetched on first paint: none')
    }
    if (check && measured.gzip > LIMIT) {
      console.error(`${measured.role} first screen ${(measured.gzip / 1024).toFixed(1)} KB gzip exceeds ${LIMIT / 1024} KB`)
      process.exitCode = 1
    }
  }
} finally {
  server.close()
  if (chrome.child) chrome.child.kill()
}
if (process.exitCode) process.exit(process.exitCode)
console.log(`\nfirst-screen max ${worst} bytes (${(worst / 1024).toFixed(1)} KB gzip, limit ${LIMIT / 1024} KB)`)
