'use strict'
// Stack frames for an error, innermost first, with the app's own code marked
// (in_app) so LoggerAI groups errors by where they happened in your code.

// No Node modules here: the Edge runtime uses this file too.
const OWN = typeof __dirname === 'string' ? __dirname : '\u0000'
const isAbsolute = (f) => f.startsWith('/') || /^[A-Za-z]:[\\/]/.test(f)
const sep = (root) => (root.includes('\\') && !root.includes('/') ? '\\' : '/')
const LINE = /^\s*at (?:async )?(?:(.*?) \()?(.+?):(\d+):(\d+)\)?$/

function inApp(file) {
  if (!file || file.startsWith('node:') || file.startsWith('internal/') || !file.includes('/') && !file.includes('\\')) return false
  return !file.includes('node_modules') && !file.startsWith(OWN) && !file.includes('/.next/server/chunks/') && !file.includes('webpack-runtime')
}

function frames(err, root, limit = 50) {
  const stack = err && typeof err.stack === 'string' ? err.stack : ''
  const out = []
  for (const line of stack.split('\n').slice(1)) {
    const m = LINE.exec(line)
    if (!m) continue
    let [, fn, file, lineNo] = m
    if (file.startsWith('file://')) {
      try {
        file = decodeURIComponent(new URL(file).pathname).replace(/^\/([A-Za-z]:)/, '$1')
      } catch {}
    }
    file = file.replace(/^webpack-internal:\/\/\/(\([^)]*\)\/)?/, '').replace(/^\.\//, '')
    const abs = isAbsolute(file)
    const rel = abs && root && file.startsWith(root + sep(root)) ? file.slice(root.length + 1) : file
    let cls = null
    let func = fn || '<anonymous>'
    const dot = func.lastIndexOf('.')
    if (dot > 0 && !func.startsWith('new ')) {
      cls = func.slice(0, dot).replace(/^Object$/, '') || null
      func = func.slice(dot + 1)
    }
    out.push({ file: rel, line: Number(lineNo), function: func, class: cls, in_app: inApp(abs ? file : rel) })
    if (out.length >= limit) break
  }
  return out
}

function typeName(err) {
  if (!err || typeof err !== 'object') return 'Error'
  const name = err.name && err.name !== 'Error' ? err.name : err.constructor && err.constructor.name
  return String(name || 'Error').slice(0, 200)
}

module.exports = { frames, typeName }
