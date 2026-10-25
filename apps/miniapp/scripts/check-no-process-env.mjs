import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const bundles = ['dist', 'dist-h5', 'dist-staff', 'dist-h5-staff']

function walk(dir) {
  const files = []
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) files.push(...walk(full))
    else if (name.endsWith('.js')) files.push(full)
  }
  return files
}

const envHits = []
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
    if (text.includes('process.env')) {
      envHits.push(path.relative(root, file))
    }
  }
}

if (envHits.length > 0) {
  console.error('process.env left in bundle js:')
  for (const file of envHits) console.error(`  ${file}`)
  console.error('Own reads must be defineConstants literals. Do not allow a whole vendor file.')
  process.exit(1)
}

const customerCommon = path.join(root, 'dist/common.js')
const customerText = readFileSync(customerCommon, 'utf8')
if (/(?<![A-Za-z0-9_$])process(?![A-Za-z0-9_$])/.test(customerText)) {
  console.error('dist/common.js still mentions process. WeChat has no process global.')
  process.exit(1)
}

console.log('bundle js has no process.env; dist/common.js has no process')
