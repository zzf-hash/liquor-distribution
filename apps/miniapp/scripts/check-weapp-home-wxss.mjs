/**
 * weapp 样式必须落在页面自己的 wxss 里。
 *
 * 四个首页的 index.scss 曾经都只有 `@use shared`，编译结果字节级相同。
 * Vite 把它们收成同一个 css 资源，@tarojs/vite-runner 的 taro:vite-style
 * 再把这个资源的 fileName 改成后处理到的那个页面。结果只有一个首页有 index.wxss，
 * 另外三个页面只有 common.wxss 里的头部样式。入口卡 class 在，规则不在，
 * 真机上就是白底通栏、图标在上、标题说明连在一起。
 *
 * 组件 comp 的 styleIsolation 是 apply-shared，页面 wxss 能进组件。
 * 缺的是页面 wxss 文件本身，不是样式隔离把 class 挡住。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dist = path.join(root, 'dist')
const failures = []

function fail(message) {
  failures.push(message)
}

function walkPages(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walkPages(full, out)
    else if (name === 'index.js') out.push(full)
  }
  return out
}

function classNames(js) {
  const found = new Set()
  for (const match of js.matchAll(/className:"([^"]*)"/g)) {
    for (const token of match[1].split(/\s+/)) {
      if (token) found.add(token)
    }
  }
  return found
}

function rules(css) {
  const out = []
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    out.push({ selector: match[1], body: match[2] })
  }
  return out
}

function selectorMatchesWeapp(part, className) {
  const token = new RegExp(`(?:^|[^\\w-])\\.${className}(?![\\w-])`)
  if (!token.test(part)) return false
  const stripped = part
    .replace(/::?[a-zA-Z-]+(\([^)]*\))?/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
  for (const piece of stripped.split(/[\s>+~]+/)) {
    const tag = piece.split(/[.#]/)[0]
    if (!tag) continue
    if (tag.startsWith('taro-') || tag === 'h5-button') return false
  }
  return true
}

function ruleFor(css, className, decls) {
  return rules(css).find((rule) => {
    const parts = rule.selector.split(',')
    const matched = parts.some((part) => selectorMatchesWeapp(part, className))
    return matched && decls.every((decl) => rule.body.includes(decl))
  })
}

function expectRule(css, page, className, decls) {
  const hit = ruleFor(css, className, decls)
  if (!hit) {
    fail(`${page} wxss 没有能命中 .${className} 的小程序选择器，或缺少 ${decls.join('、')}`)
  }
}

if (!statSync(dist, { throwIfNoEntry: false })) {
  console.error('missing dist; run build:weapp first')
  process.exit(1)
}

const commonJs = readFileSync(path.join(dist, 'common.js'), 'utf8')
const commonClasses = classNames(commonJs)
const pageJsFiles = walkPages(path.join(dist, 'pages'))

for (const file of pageJsFiles) {
  const dir = path.dirname(file)
  const page = path.relative(dist, dir)
  const sourcePath = path.join(root, 'src', page, 'index.tsx')
  let source = ''
  try {
    source = readFileSync(sourcePath, 'utf8')
  } catch {
    source = ''
  }
  const importsStyle = /import\s+['"]\.\/index\.(scss|css)['"]/.test(source)
  const wxssPath = path.join(dir, 'index.wxss')
  let wxss = ''
  try {
    wxss = readFileSync(wxssPath, 'utf8')
  } catch {
    if (importsStyle) fail(`${page} 引用了 index.scss，但 dist 没有 index.wxss`)
    continue
  }
  if (importsStyle && !wxss.trim()) fail(`${page} 的 index.wxss 是空的`)
  if (!importsStyle) continue

  const js = readFileSync(file, 'utf8')
  const pageClasses = classNames(js)

  if (pageClasses.has('entry-list')) {
    for (const className of [
      'entry-card',
      'entry-card__icon',
      'entry-card__main',
      'entry-card__title',
      'entry-card__desc',
      'entry-card__side',
      'entry-card__arrow',
    ]) {
      if (!commonClasses.has(className)) fail(`common.js 缺少入口卡 class ${className}`)
    }
    expectRule(wxss, page, 'entry-list', ['display:flex', 'flex-direction:column', 'gap:24rpx', 'margin-top:-28rpx'])
    expectRule(wxss, page, 'entry-card', [
      'display:flex',
      'flex-direction:row',
      'min-height:144rpx',
      'padding:32rpx',
      'border-radius:28rpx',
      'background:#FFFFFF',
      'box-shadow:0 4rpx 20rpx',
    ])
    expectRule(wxss, page, 'entry-card__icon', ['width:88rpx', 'height:88rpx', 'border-radius:24rpx', 'background:#F7EFE6'])
    expectRule(wxss, page, 'entry-card__main', ['display:flex', 'flex-direction:column'])
    expectRule(wxss, page, 'entry-card__title', ['display:block', 'font-size:32rpx', 'font-weight:600'])
    expectRule(wxss, page, 'entry-card__desc', ['display:block', 'font-size:24rpx', 'color:#6b5f5a'])
    expectRule(wxss, page, 'entry-card__arrow', ['font-size:36rpx'])
    expectRule(wxss, page, 'grid-home', ['padding:32rpx'])
    expectRule(wxss, page, 'btn-neutral', ['background:#FFFFFF', 'border:2rpx solid #D9D0CA'])
    expectRule(wxss, page, 'btn-md', ['border-radius:20rpx'])
    expectRule(wxss, page, 'home-logout', ['margin-top:24rpx'])
    for (const className of ['entry-list', 'grid-home', 'btn-neutral', 'btn-md', 'home-logout']) {
      if (!pageClasses.has(className)) fail(`${page} 的 js 没有 class ${className}`)
    }
  }

  if (pageClasses.has('task-row')) {
    expectRule(wxss, page, 'task-card', ['display:flex', 'align-items:center', 'border-radius:28rpx', 'background:#FFFFFF'])
    expectRule(wxss, page, 'task-card__main', ['display:flex', 'flex-direction:column'])
    expectRule(wxss, page, 'task-card__title', ['display:block'])
    expectRule(wxss, page, 'task-card__desc', ['display:block'])
    expectRule(wxss, page, 'btn-neutral', ['border:2rpx solid #D9D0CA'])
    expectRule(wxss, page, 'btn-md', ['border-radius:20rpx'])
    for (const className of ['task-card', 'task-card__main', 'task-card__title', 'task-card__desc', 'btn-neutral', 'btn-md']) {
      if (!pageClasses.has(className)) fail(`${page} 的 js 没有 class ${className}`)
    }
  }
}

const homes = [
  'pages/warehouse/home',
  'pages/clerk/home',
  'pages/boss/home',
  'pages/salesman/home',
]
for (const page of homes) {
  if (!pageJsFiles.some((file) => path.relative(dist, path.dirname(file)) === page)) {
    fail(`缺少页面 ${page}`)
  }
}

if (failures.length > 0) {
  console.error('weapp home wxss check failed:')
  for (const item of failures) console.error(`  ${item}`)
  process.exit(1)
}

console.log('weapp wxss: pages that import index.scss all have index.wxss; entry cards and task cards match their class names')
