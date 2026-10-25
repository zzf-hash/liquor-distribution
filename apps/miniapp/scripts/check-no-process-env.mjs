import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const bundles = ['dist', 'dist-h5']
const forbidden = ['process.env', '{}.TARO_APP_']
const expectedApiBase = (process.env.TARO_APP_API_BASE || 'http://127.0.0.1:3000/api').trim() || 'http://127.0.0.1:3000/api'

function walk(dir) {
  const files = []
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) files.push(...walk(full))
    else if (name.endsWith('.js')) files.push(full)
  }
  return files
}

const hits = []
for (const bundle of bundles) {
  const dir = path.join(root, bundle)
  let files
  try {
    files = walk(dir)
  } catch {
    console.error(`missing bundle ${bundle}`)
    process.exit(1)
  }
  if (files.length === 0) {
    console.error(`no js in ${bundle}`)
    process.exit(1)
  }
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (const needle of forbidden) {
      if (text.includes(needle)) hits.push(`${path.relative(root, file)} contains ${needle}`)
    }
  }
}

if (hits.length > 0) {
  console.error('bundle js still reads the environment:')
  for (const hit of hits) console.error(`  ${hit}`)
  console.error('Own reads must be defineConstants literals. Do not allow a whole vendor file.')
  process.exit(1)
}

const customerCommon = path.join(root, 'dist/common.js')
const customerText = readFileSync(customerCommon, 'utf8')
if (/(?<![A-Za-z0-9_$])process(?![A-Za-z0-9_$])/.test(customerText)) {
  console.error('dist/common.js still mentions process. WeChat has no process global.')
  process.exit(1)
}
if (!customerText.includes(expectedApiBase)) {
  console.error(`dist/common.js is missing the API base literal ${expectedApiBase}`)
  process.exit(1)
}

console.log(`bundle js has no process.env or {}.TARO_APP_; dist/common.js has no process; API base is ${expectedApiBase}`)
