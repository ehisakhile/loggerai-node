'use strict'
// Times every incoming request (any framework on Node's http server) and what
// it waits on: outgoing HTTP (http/https, axios, got, fetch), PostgreSQL (pg),
// MySQL (mysql2), Redis (ioredis). Warnings and errors from console are logs.
// Each is patched once and costs nothing outside a request.

const dc = require('node:diagnostics_channel')
const http = require('node:http')
const https = require('node:https')
const { createRequire, syncBuiltinESMExports } = require('node:module')
const path = require('node:path')

const ctx = require('./context')

const done = new Set()
const once = (name) => (done.has(name) ? false : (done.add(name), true))

/** The app's copy of a library (not one bundled inside this package). */
function appRequire(client, name) {
  for (const base of [path.join(client.root, 'package.json'), path.join(process.cwd(), 'package.json')]) {
    try {
      return createRequire(base)(name)
    } catch {}
  }
  return null
}

// ---- incoming requests -------------------------------------------------------------------

const NEXT_META = Symbol.for('NextInternalRequestMeta')

/** The route template when the framework set one on the request: Express (and Nest on
 * Express), Fastify (through its plugin), Next.js (the page or route file it matched). */
function frameworkRoute(req) {
  if (req.loggeraiRoute) return req.loggeraiRoute
  const r = req.route
  if (r && typeof r.path === 'string') return (req.baseUrl || '') + r.path
  try {
    const def = req[NEXT_META] && req[NEXT_META].match && req[NEXT_META].match.definition
    if (def && typeof def.pathname === 'string') return def.pathname
  } catch {}
  return null
}

function server(client) {
  if (!once('server')) return
  for (const proto of [http.Server.prototype, https.Server.prototype]) {
    const emit = proto.emit
    proto.emit = function (event, req, res) {
      if (event !== 'request' || !client.enabled || !req || !res || ctx.current() || client.ignored(req.url)) {
        return emit.apply(this, arguments)
      }
      const h = req.headers || {}
      const unit = new ctx.Unit('http', String(req.method || 'GET').toUpperCase(), ctx.traceFrom(h.traceparent), ctx.sessionFrom(h['x-loggerai-session']))
      req.loggeraiUnit = unit
      const finish = () => {
        if (unit.finished) return
        unit.route = unit.route || frameworkRoute(req) || client.fallbackRoute(req.originalUrl || req.url)
        client.finish(unit, res.statusCode || 0)
      }
      res.once('finish', finish)
      res.once('close', finish)
      return ctx.store.run(unit, () => emit.apply(this, arguments))
    }
  }
}

// ---- outgoing HTTP ---------------------------------------------------------------------------

/** [hostname, port] of an http.request() call. */
function hostOf(args, secure) {
  const a = args[0]
  const dflt = secure ? 443 : 80
  try {
    if (typeof a === 'string' || a instanceof URL) {
      const u = new URL(a)
      return [u.hostname, Number(u.port) || dflt]
    }
    if (a && typeof a === 'object') {
      const [h, p] = String(a.hostname || a.host || 'localhost').split(':')
      return [h, Number(a.port || p) || dflt]
    }
  } catch {}
  return ['unknown', dflt]
}

function methodOf(args) {
  for (const a of args) if (a && typeof a === 'object' && !(a instanceof URL) && a.method) return String(a.method).toUpperCase()
  return 'GET'
}

function httpClient(client) {
  if (!client.captureHttp || !once('http-client')) return
  for (const mod of [http, https]) {
    const original = mod.request
    const wrapped = function (...args) {
      const req = original.apply(this, args)
      const unit = ctx.current()
      if (!unit || unit.finished) return req
      const [target, port] = hostOf(args, mod === https)
      if (client.isSelf(target, port)) return req
      const start = process.hrtime.bigint()
      let recorded = false
      const record = (ok) => {
        if (recorded) return
        recorded = true
        ctx.store.run(unit, () => ctx.dependency(target, methodOf(args), ctx.since(start), ok))
      }
      req.once('response', (res) => record(res.statusCode < 500))
      req.once('error', () => record(false))
      return req
    }
    mod.request = wrapped
    // get() calls the module's own request, which isn't the patched one: wrap it too.
    mod.get = function (...args) {
      const req = wrapped.apply(this, args)
      req.end()
      return req
    }
  }
  try {
    syncBuiltinESMExports() // `import { request } from 'node:http'` sees the patched one
  } catch {}
}

/** fetch() is undici inside Node: it reports each request on diagnostics channels. */
function fetchClient(client) {
  if (!client.captureHttp || !once('fetch')) return
  const pending = new WeakMap()
  dc.subscribe('undici:request:create', ({ request }) => {
    const unit = ctx.current()
    if (!unit || unit.finished || !request) return
    let target = 'unknown'
    try {
      const u = new URL(request.origin)
      target = u.hostname
      if (client.isSelf(target, Number(u.port) || (u.protocol === 'https:' ? 443 : 80))) return
    } catch {}
    pending.set(request, { unit, target, method: String(request.method || 'GET').toUpperCase(), start: process.hrtime.bigint() })
  })
  const end = (request, ok) => {
    const p = request && pending.get(request)
    if (!p) return
    pending.delete(request)
    p.unit.dep(p.target, p.method, ctx.since(p.start), ok)
  }
  dc.subscribe('undici:request:headers', ({ request, response }) => end(request, !response || response.statusCode < 500))
  dc.subscribe('undici:request:error', ({ request }) => end(request, false))
}

// ---- databases and caches ------------------------------------------------------------------

/** Wrap fn so the call is timed, whether it takes a callback or returns a promise. */
function timed(original, target, opOf) {
  return function (...args) {
    const unit = ctx.current()
    if (!unit || unit.finished) return original.apply(this, args)
    const t = typeof target === 'function' ? target(this) : target
    const op = opOf(args)
    const start = process.hrtime.bigint()
    let recorded = false
    const record = (ok) => {
      if (recorded) return
      recorded = true
      unit.dep(t, op, ctx.since(start), ok)
    }
    const cbAt = args.length && typeof args[args.length - 1] === 'function' ? args.length - 1 : -1
    if (cbAt >= 0) {
      const cb = args[cbAt]
      args[cbAt] = function (err) {
        record(!err)
        return cb.apply(this, arguments)
      }
    }
    let result
    try {
      result = original.apply(this, args)
    } catch (e) {
      record(false)
      throw e
    }
    if (cbAt >= 0 || !result) return result
    if (typeof result.once === 'function') {
      // An emitter (mysql2's query() without a callback). Never touch its then(): mysql2 makes it throw.
      result.once('end', () => record(true))
      result.once('error', () => record(false))
    } else if (result instanceof Promise) {
      result.then(() => record(true), () => record(false))
    }
    return result
  }
}

function pg(client) {
  const lib = appRequire(client, 'pg')
  if (!lib || !lib.Client || !once('pg')) return
  lib.Client.prototype.query = timed(lib.Client.prototype.query, 'postgres', (a) => ctx.sqlVerb(a[0]))
}

function mysql2(client) {
  const lib = appRequire(client, 'mysql2')
  const Conn = lib && lib.Connection
  if (!Conn || !once('mysql2')) return
  // Pools and mysql2/promise end up in a connection's query/execute.
  const proto = Object.getPrototypeOf(Conn.prototype) && Object.getPrototypeOf(Conn.prototype).query ? Object.getPrototypeOf(Conn.prototype) : Conn.prototype
  for (const m of ['query', 'execute']) {
    if (typeof proto[m] === 'function') proto[m] = timed(proto[m], 'mysql', (a) => ctx.sqlVerb(a[0]))
  }
}

function ioredis(client) {
  const Redis = appRequire(client, 'ioredis')
  const R = Redis && (Redis.default || Redis)
  if (!R || !R.prototype || typeof R.prototype.sendCommand !== 'function' || !once('ioredis')) return
  const send = R.prototype.sendCommand
  R.prototype.sendCommand = function (command) {
    const unit = ctx.current()
    if (!unit || unit.finished || !command || !command.promise) return send.apply(this, arguments)
    const start = process.hrtime.bigint()
    const op = String(command.name || '?').toUpperCase()
    command.promise.then(() => unit.dep('redis', op, ctx.since(start), true), () => unit.dep('redis', op, ctx.since(start), false))
    return send.apply(this, arguments)
  }
}

// ---- logs -------------------------------------------------------------------------------------------

const LEVELS = { DEBUG: 10, INFO: 20, WARNING: 30, ERROR: 40, CRITICAL: 50 }

function consoleLogs(client) {
  if (!client.captureConsole || !client.logsLevel || !once('console')) return
  const min = LEVELS[String(client.logsLevel).toUpperCase()] || 30
  const { format } = require('node:util')
  for (const [method, level] of [['warn', 'WARNING'], ['error', 'ERROR']]) {
    if (LEVELS[level] < min) continue
    const original = console[method]
    let inside = false
    console[method] = function (...args) {
      if (!inside) {
        inside = true
        try {
          const err = args.find((a) => a instanceof Error)
          client.log(level, 'console', err && args.length === 1 ? `${err.name}: ${err.message}` : format(...args))
        } catch {}
        inside = false
      }
      return original.apply(this, args)
    }
  }
}

function crashes(client) {
  if (!once('crashes')) return
  // A monitor doesn't change what Node does with the crash; it only lets us see it first.
  process.on('uncaughtExceptionMonitor', (err, origin) => {
    client.exception(err, { status: null, handled: false, extra: { origin } })
    client.flushSync()
  })
}

function all(client) {
  server(client)
  httpClient(client)
  fetchClient(client)
  if (client.captureQueries) {
    pg(client)
    mysql2(client)
    ioredis(client)
  }
  consoleLogs(client)
  crashes(client)
}

module.exports = { all, appRequire, frameworkRoute }
