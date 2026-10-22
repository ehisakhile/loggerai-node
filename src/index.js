'use strict'
/**
 * LoggerAI for Node.js: performance monitoring, errors, logs and health
 * checks for Express, Fastify, NestJS, Next.js and any app on Node's http server.
 *
 *   const loggerai = require('@loggerai/node')
 *   loggerai.init()                       // reads LOGGERAI_KEY (sk_live_...)
 *
 * Call it before the app starts listening. Nothing is sent without a key,
 * nothing ever throws into your app, and secrets are masked before anything
 * leaves it.
 */

const { Client } = require('./client')
const ctx = require('./context')
const instrument = require('./instrument')
const { VERSION } = require('./version')

let client = null

/** Start LoggerAI. Every option also has an environment variable: key (LOGGERAI_KEY),
 * endpoint, service, environment, release, enabled. See README for the rest. */
function init(options = {}) {
  if (client) client.close(1000).catch(() => {})
  client = new Client(options)
  if (client.enabled) {
    if (options.quiet !== true) process.stderr.write(`LoggerAI: sending as ${client.service} (${client.environment}) to ${client.endpoint}\n`)
    instrument.all(client)
    client.start()
    // Send what's left when the process is asked to stop (deploys, Ctrl-C, containers).
    if (!init.hooked) {
      init.hooked = true
      process.once('beforeExit', () => client && client.flush(2000))
      for (const sig of ['SIGTERM', 'SIGINT']) {
        process.once(sig, () => {
          const c = client
          const exit = () => {
            // Only exit ourselves when nobody else handles the signal.
            if (process.listenerCount(sig) === 0) process.kill(process.pid, sig)
          }
          if (c) c.flush(2000).then(exit, exit)
          else exit()
        })
      }
    }
  } else if (!client.key && options.quiet !== true) {
    process.stderr.write('LoggerAI: off (no LOGGERAI_KEY)\n')
  }
  return client
}

const getClient = () => client

/** Report an error you handled but still want to see. */
function captureException(err, extra) {
  if (client) client.exception(err, { handled: true, extra: extra || null })
}

/** Count the current request against a user. Only a one-way hash of the id is sent. */
function setUser(id) {
  const unit = ctx.current()
  if (unit && client) unit.user = client.userRef(id)
}

/** Name the current request yourself (a template like /orders/:id, never a raw path). */
function setRoute(template) {
  const unit = ctx.current()
  if (unit && template) unit.route = String(template).slice(0, 255)
}

/** Time a call LoggerAI can't see on its own (an SDK with its own client, Prisma, MongoDB):
 *
 *   const intent = await loggerai.measure('api.stripe.com', 'POST', () => stripe.paymentIntents.confirm(id))
 */
function measure(target, operation, fn) {
  const start = process.hrtime.bigint()
  const done = (ok) => ctx.dependency(target, operation || 'CALL', ctx.since(start), ok)
  let r
  try {
    r = fn()
  } catch (e) {
    done(false)
    throw e
  }
  if (r && typeof r.then === 'function') return r.then((v) => (done(true), v), (e) => (done(false), Promise.reject(e)))
  done(true)
  return r
}

/** Time a unit of work outside a web request: a queue job, a cron task, a script.
 *
 *   await loggerai.track('job', 'SendInvoices', async () => { ... })
 */
function track(kind, name, fn) {
  if (!client || !client.enabled) return fn()
  const k = ['job', 'command', 'http'].includes(kind) ? kind : 'job'
  const unit = new ctx.Unit(k, k === 'command' ? 'CLI' : 'JOB')
  unit.route = String(name).slice(0, 255)
  return ctx.store.run(unit, () => {
    const fail = (e) => {
      client.exception(e, { status: 500 })
      client.finish(unit, 500)
      throw e
    }
    let r
    try {
      r = fn()
    } catch (e) {
      fail(e)
    }
    if (r && typeof r.then === 'function') return r.then((v) => (client.finish(unit, 200), v), fail)
    client.finish(unit, 200)
    return r
  })
}

/** Send everything now (at the end of a script or a serverless call). */
function flush(timeoutMs = 5000) {
  return client ? client.flush(timeoutMs) : Promise.resolve(true)
}

/** Add health checks: each returns true/false (or a promise), or [ok, detail]. */
function healthChecks(checks) {
  if (!client) return
  Object.assign(client.healthChecks, checks)
  client.nextHealth = 0
  client.start()
}

/** A log line of your own, at any level (DEBUG, INFO, WARNING, ERROR, CRITICAL). */
function log(level, message, logger = 'app') {
  if (client) client.log(String(level).toUpperCase(), logger, message)
}

// ---- frameworks ------------------------------------------------------------------------------

/** Express (and Nest on Express): routes are named on their own; add this after your
 * routes so errors are reported with their stack. It passes the error on unchanged.
 *
 *   app.use(loggerai.expressErrorHandler())
 */
function expressErrorHandler() {
  return function loggeraiErrorHandler(err, req, res, next) {
    const status = Number((err && (err.status || err.statusCode)) || 500)
    if (client && status >= 500) {
      const route = instrument.frameworkRoute(req)
      if (req.loggeraiUnit && route) req.loggeraiUnit.route = route
      client.exception(err, { status, route })
    }
    next(err)
  }
}

/** Fastify: `await app.register(loggerai.fastify)` names each request by its route and
 * reports errors. */
function fastify(app, _opts, done) {
  app.addHook('onRequest', (request, _reply, next) => {
    const unit = request.raw && request.raw.loggeraiUnit
    const url = (request.routeOptions && request.routeOptions.url) || request.routerPath
    if (unit && url) unit.route = url
    if (request.raw && url) request.raw.loggeraiRoute = url
    next()
  })
  app.addHook('onError', (request, reply, error, next) => {
    const status = Number(error.statusCode || 500) // a thrown error without a status is a 500
    if (client && status >= 500) {
      client.exception(error, { status, route: request.raw && request.raw.loggeraiRoute, method: request.method })
    }
    next()
  })
  done()
}
fastify[Symbol.for('skip-override')] = true // apply to the whole app, like fastify-plugin
fastify[Symbol.for('fastify.display-name')] = 'loggerai'

/** Next.js: in instrumentation.ts, report server errors with the route they happened on.
 *
 *   export async function onRequestError(...args) {
 *     if (process.env.NEXT_RUNTIME === 'nodejs') (await import('@loggerai/node')).nextOnRequestError(...args)
 *   }
 */
function nextOnRequestError(err, request, context) {
  if (!client) return
  const route = context && context.routePath ? context.routePath : null
  const unit = ctx.current()
  if (unit && route) unit.route = route
  client.exception(err, {
    status: 500,
    route,
    method: request && request.method,
    extra: context ? { router: context.routerKind, type: context.routeType, source: context.renderSource } : null,
  })
  if (client.serverless) client.flushSoon()
}

/** Next.js route handlers: names the request by its file route (/api/orders/[id]) and
 * reports errors. `export const GET = withLoggerAI(async (req, { params }) => ...)` */
function withLoggerAI(handler, route) {
  return async function (req, context) {
    const name = route || (await routeFromParams(req, context))
    const unit = ctx.current()
    if (!unit && client && client.enabled) {
      // No server around us (some serverless platforms): time it here.
      return track('http', name || '(unmatched)', () => handler(req, context))
    }
    if (unit && name) unit.route = name
    try {
      return await handler(req, context)
    } catch (e) {
      if (client) client.exception(e, { status: 500, route: name })
      throw e
    }
  }
}

/** /orders/42 with params {id: '42'} -> /orders/[id]. */
async function routeFromParams(req, context) {
  let pathname
  try {
    pathname = new URL(req.url).pathname
  } catch {
    return null
  }
  let params = context && context.params
  if (params && typeof params.then === 'function') params = await params
  if (!params) return null
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

module.exports = {
  init,
  getClient,
  captureException,
  setUser,
  setRoute,
  measure,
  track,
  flush,
  healthChecks,
  log,
  expressErrorHandler,
  fastify,
  nextOnRequestError,
  withLoggerAI,
  VERSION,
}
