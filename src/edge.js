'use strict'
/**
 * LoggerAI for edge runtimes: Next.js Edge routes, pages and middleware, Vercel
 * Edge Functions, Cloudflare Workers. Picked automatically when the bundler
 * targets the edge (the "edge-light" and "workerd" conditions), or import
 * '@loggerai/node/edge' yourself.
 *
 * There's no background thread at the edge, so each request's data is sent
 * when it ends, kept alive with waitUntil.
 */

const { frames, typeName } = require('./frames')
const { redact, redactString } = require('./redact')
const { VERSION } = require('./version')

const DEFAULT_ENDPOINT = 'https://loggerapp.ehigiator.com/api/v1/ingest/batch'
const TRACEPARENT = /^[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/
const ID_SEGMENT = /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{12,}|[A-Za-z0-9_-]{20,})$/i

const env = (name) => {
  try {
    const v = typeof process !== 'undefined' && process.env ? process.env[name] : undefined
    return v === undefined || v === '' ? undefined : v
  } catch {
    return undefined
  }
}

// Requests in flight, followed through awaits where the runtime has AsyncLocalStorage
// (Next.js and Vercel Edge do; Cloudflare with nodejs_compat does).
const ALS = globalThis.AsyncLocalStorage
const store = ALS ? new ALS() : null
const current = () => (store ? store.getStore() || null : null)

let config = null
let pending = { requests: [], errors: [], logs: [] }
const originalFetch = globalThis.fetch

function init(options = {}) {
  const key = options.key || env('LOGGERAI_KEY')
  const on = options.enabled === undefined ? !['0', 'false', 'no', 'off'].includes(String(env('LOGGERAI_ENABLED') || 'true').toLowerCase()) : !!options.enabled
  config = {
    key,
    endpoint: options.endpoint || env('LOGGERAI_ENDPOINT') || DEFAULT_ENDPOINT,
    service: options.service || env('LOGGERAI_SERVICE') || 'app',
    environment: options.environment || env('LOGGERAI_ENVIRONMENT') || env('NODE_ENV') || 'production',
    release: options.release || env('LOGGERAI_RELEASE') || env('VERCEL_GIT_COMMIT_SHA') || null,
    host: options.host || env('VERCEL_REGION') || 'edge',
    enabled: !!(on && key && key.startsWith('sk_')),
    captureHttp: options.captureHttp !== false,
    lastError: null,
  }
  if (config.enabled && config.captureHttp) patchFetch()
  return { enabled: config.enabled, endpoint: config.endpoint, service: config.service, environment: config.environment, release: config.release }
}

function ensure() {
  if (!config) init()
  return config.enabled
}

/** Inside a self-hosted Next.js server, whose Node side (with LoggerAI) already records
 * every request, error and fetch: nothing to do here. */
const underNode = () => env('LOGGERAI_NODE_SERVER') === '1'

function nextRoute(p) {
  if (!p) return null
  return String(p).replace(/\/(route|page)$/, '') || '/'
}

function hex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function newUnit(method, headers) {
  const tp = TRACEPARENT.exec(String((headers && headers.get && headers.get('traceparent')) || '').trim().toLowerCase())
  const session = String((headers && headers.get && headers.get('x-loggerai-session')) || '').trim()
  return {
    kind: 'http',
    method: String(method || 'GET').toUpperCase(),
    route: null,
    traceId: tp && tp[1] !== '0'.repeat(32) ? tp[1] : hex(crypto.getRandomValues(new Uint8Array(16))),
    sessionId: session && /^[A-Za-z0-9._:-]+$/.test(session) ? session.slice(0, 64) : null,
    userId: null,
    ts: Date.now() / 1000,
    started: performance.now(),
    deps: new Map(),
    finished: false,
  }
}

function dep(unit, target, op, ms, ok) {
  const k = `${target}\u0000${op}`
  let d = unit.deps.get(k)
  if (!d) unit.deps.set(k, (d = { target: String(target).slice(0, 120), op: String(op).toUpperCase().slice(0, 20), count: 0, ms: 0, errors: 0 }))
  d.count += 1
  d.ms += ms
  if (!ok) d.errors += 1
}

/** fetch() calls made while serving a request are timed, by host. */
function patchFetch() {
  if (!originalFetch || globalThis.fetch.__loggerai) return
  const wrapped = async function (input, init) {
    const unit = current()
    if (!unit || unit.finished) return originalFetch(input, init)
    let target = 'unknown'
    let method = (init && init.method) || (input && typeof input === 'object' && input.method) || 'GET'
    try {
      const u = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
      target = u.hostname
      if (u.href.startsWith(config.endpoint)) return originalFetch(input, init)
    } catch {}
    const t = performance.now()
    try {
      const r = await originalFetch(input, init)
      dep(unit, target, method, performance.now() - t, r.status < 500)
      return r
    } catch (e) {
      dep(unit, target, method, performance.now() - t, false)
      throw e
    }
  }
  wrapped.__loggerai = true
  globalThis.fetch = wrapped
}

function routeFromPath(pathname) {
  return '/' + String(pathname || '/').split('/').filter(Boolean).map((s) => (ID_SEGMENT.test(s) || s.length > 60 ? '{id}' : s)).join('/')
}

/** /orders/42 with params {id: '42'} -> /orders/[id]. */
async function routeFromParams(url, context) {
  let pathname
  try {
    pathname = new URL(url).pathname
  } catch {
    return null
  }
  let params = context && context.params
  if (params && typeof params.then === 'function') params = await params
  if (!params || !Object.keys(params).length) return null
  const segs = pathname.split('/')
  for (const [name, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      const joined = value.map(encodeURIComponent).join('/')
      const at = pathname.indexOf('/' + joined)
      if (at >= 0) return pathname.slice(0, at) + `/[...${name}]`
      continue
    }
    const i = segs.findIndex((s, k) => k > 0 && decodeURIComponent(s) === String(value))
    if (i > 0) segs[i] = `[${name}]`
  }
  return segs.join('/')
}

function errorRecord(err, { status = null, handled = false, route = null, method = null, extra = null } = {}) {
  if (!err || typeof err !== 'object') err = new Error(String(err))
  const unit = current()
  return {
    ts: Math.round(Date.now()) / 1000,
    type: typeName(err),
    message: redactString(String(err.message || err).slice(0, 1000)),
    handled,
    route: route || (unit && unit.route) || null,
    method: method || (unit && unit.method) || null,
    status,
    trace_id: unit ? unit.traceId : null,
    frames: frames(err, ''),
    context: extra ? redact(extra) : {},
  }
}

async function userRef(id) {
  if (id === null || id === undefined || id === '') return null
  try {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(config.key || ''), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(String(id)))
    return hex(new Uint8Array(sig)).slice(0, 16)
  } catch {
    return null
  }
}

async function finishUnit(unit, status) {
  if (unit.finished) return
  unit.finished = true
  pending.requests.push({
    ts: Math.round(unit.ts * 1000) / 1000,
    kind: unit.kind,
    method: unit.method,
    route: unit.route || '(unmatched)',
    status: Number(status) || 0,
    duration_ms: Math.round((performance.now() - unit.started) * 100) / 100,
    trace_id: unit.traceId,
    session_id: unit.sessionId,
    user: await userRef(unit.userId),
    deps: [...unit.deps.values()].map((d) => ({ ...d, ms: Math.round(d.ms * 100) / 100 })),
  })
}

/** Sends what's waiting. Returns the promise; pass it to waitUntil. */
async function flush() {
  if (!config || !config.enabled) return true
  const parts = {}
  for (const k of Object.keys(pending)) if (pending[k].length) parts[k] = pending[k].splice(0, 1000)
  if (!Object.keys(parts).length) return true
  const json = JSON.stringify({
    sdk: { name: 'loggerai-node-edge', version: VERSION },
    service: config.service,
    environment: config.environment,
    release: config.release,
    host: config.host,
    ...parts,
  })
  const headers = { 'Content-Type': 'application/json', 'X-LoggerAI-Key': config.key }
  let body = json
  try {
    if (typeof CompressionStream === 'function') {
      body = await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer()
      headers['Content-Encoding'] = 'gzip'
    }
  } catch {
    body = json
  }
  try {
    const r = await originalFetch(config.endpoint, { method: 'POST', headers, body })
    config.lastError = r.ok ? null : `LoggerAI answered ${r.status}`
    if (r.status === 401) config.enabled = false
    return r.ok
  } catch (e) {
    config.lastError = `couldn't reach LoggerAI: ${e && e.message}`
    return false
  }
}

/** Keep the function alive until the batch is out (Next.js, Vercel, Cloudflare). */
function later(promise, ctx) {
  try {
    if (ctx && typeof ctx.waitUntil === 'function') return ctx.waitUntil(promise)
    const rc = globalThis[Symbol.for('@vercel/request-context')]
    const c = rc && rc.get && rc.get()
    if (c && typeof c.waitUntil === 'function') return c.waitUntil(promise)
    const next = globalThis[Symbol.for('@next/request-context')]
    const n = next && next.get && next.get()
    if (n && typeof n.waitUntil === 'function') return n.waitUntil(promise)
  } catch {}
  return promise
}

/**
 * Next.js Edge route handlers (export const runtime = 'edge'), Vercel Edge Functions:
 *
 *   export const GET = withLoggerAI(async (req, { params }) => Response.json(...))
 *
 * Times the request, names it by its file route (/api/orders/[id]), reports errors.
 * The second argument names the route yourself.
 */
function withLoggerAI(handler, route) {
  return async function (req, context) {
    if (underNode() || !ensure() || current()) return handler(req, context)
    const unit = newUnit(req && req.method, req && req.headers)
    const run = async () => {
      unit.route = route || (await routeFromParams(req.url, context)) || (() => {
        try {
          return routeFromPath(new URL(req.url).pathname)
        } catch {
          return null
        }
      })()
      try {
        const res = await handler(req, context)
        await finishUnit(unit, res && res.status ? res.status : 200)
        return res
      } catch (e) {
        pending.errors.push(errorRecord(e, { status: 500, route: unit.route, method: unit.method }))
        await finishUnit(unit, 500)
        throw e
      } finally {
        later(flush(), context)
      }
    }
    return store ? store.run(unit, run) : run()
  }
}

/** Next.js middleware: reports errors it throws, and times the calls it makes.
 * It isn't counted as a request of its own (the page or route it leads to is). */
function withLoggerAIMiddleware(middleware) {
  return async function (req, event) {
    if (underNode() || !ensure()) return middleware(req, event)
    const unit = newUnit(req && req.method, req && req.headers)
    unit.route = 'middleware'
    const run = async () => {
      try {
        return await middleware(req, event)
      } catch (e) {
        pending.errors.push(errorRecord(e, { status: 500, route: 'middleware', method: unit.method }))
        later(flush(), event)
        throw e
      }
    }
    return store ? store.run(unit, run) : run()
  }
}

/** For instrumentation.ts when NEXT_RUNTIME is 'edge': errors with the route they happened on. */
function nextOnRequestError(err, request, context) {
  // Even inside a Node server: Next calls this on the edge side for edge pages and middleware.
  if (!ensure()) return
  pending.errors.push(errorRecord(err, {
    status: 500,
    route: nextRoute(context && context.routePath),
    method: request && request.method,
    extra: context ? { router: context.routerKind, type: context.routeType, source: context.renderSource, runtime: 'edge' } : null,
  }))
  return later(flush())
}

function captureException(err, extra) {
  if (!ensure()) return
  pending.errors.push(errorRecord(err, { handled: true, extra: extra || null }))
  if (!current()) later(flush())
}

function setUser(id) {
  const unit = current()
  if (unit) unit.userId = id
}

function setRoute(template) {
  const unit = current()
  if (unit && template) unit.route = String(template).slice(0, 255)
}

function log(level, message, logger = 'app') {
  if (!ensure()) return
  const unit = current()
  pending.logs.push({
    ts: Math.round(Date.now()) / 1000,
    level: String(level).toUpperCase(),
    logger,
    message: redactString(String(message).slice(0, 8000)),
    route: unit ? unit.route : null,
    trace_id: unit ? unit.traceId : null,
  })
  if (!unit) later(flush())
}

async function measure(target, operation, fn) {
  const unit = current()
  const t = performance.now()
  try {
    const r = await fn()
    if (unit) dep(unit, target, operation || 'CALL', performance.now() - t, true)
    return r
  } catch (e) {
    if (unit) dep(unit, target, operation || 'CALL', performance.now() - t, false)
    throw e
  }
}

const getClient = () => config

module.exports = {
  init,
  getClient,
  withLoggerAI,
  withLoggerAIMiddleware,
  nextOnRequestError,
  captureException,
  setUser,
  setRoute,
  log,
  measure,
  flush,
  VERSION,
  // Node-only helpers: harmless no-ops here, so shared code still runs at the edge.
  expressErrorHandler: () => (err, req, res, next) => next(err),
  fastify: (app, opts, done) => done(),
  healthChecks: () => {},
  track: (_kind, _name, fn) => fn(),
}
