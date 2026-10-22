'use strict'
// The client: settings, the buffer, and a timer that sends batches to LoggerAI
// every few seconds. Nothing here ever throws into the app or makes a request
// wait; when LoggerAI can't be reached, records are dropped rather than piling up.

const crypto = require('node:crypto')
const http = require('node:http')
const https = require('node:https')
const os = require('node:os')
const zlib = require('node:zlib')
const { spawnSync } = require('node:child_process')

const ctx = require('./context')
const { frames, typeName } = require('./frames')
const { redact, redactString } = require('./redact')
const { VERSION } = require('./version')

const DEFAULT_ENDPOINT = 'https://loggerapp.ehigiator.com/api/v1/ingest/batch'
const KINDS = ['requests', 'errors', 'logs', 'checks', 'hosts']
const MAX_BUFFER = 10000 // per kind; beyond this the oldest go
const MAX_PER_BATCH = 1000 // the server's limit per kind
const MAX_BATCH_BYTES = 900000 // under the server's 1 MB
const MAX_FALLBACK_ROUTES = 300 // route names guessed from paths, before the rest become "(other)"

// Kept before anything is patched, so sending never records itself.
const request = { 'http:': http.request, 'https:': https.request }

const env = (name, dflt) => {
  const v = process.env[name]
  return v === undefined || v === '' ? dflt : v
}
const truthy = (v) => !['0', 'false', 'no', 'off', ''].includes(String(v).trim().toLowerCase())

const ID_SEGMENT = /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{12,}|[A-Za-z0-9_-]{20,})$/i

class Client {
  constructor(options = {}) {
    const o = options
    this.key = o.key || env('LOGGERAI_KEY')
    this.endpoint = o.endpoint || env('LOGGERAI_ENDPOINT', DEFAULT_ENDPOINT)
    this.service = o.service || env('LOGGERAI_SERVICE', 'app')
    this.environment = o.environment || env('LOGGERAI_ENVIRONMENT') || env('NODE_ENV') || 'production'
    this.release = o.release || env('LOGGERAI_RELEASE') || env('VERCEL_GIT_COMMIT_SHA') || null
    const on = o.enabled === undefined ? truthy(env('LOGGERAI_ENABLED', 'true')) : !!o.enabled
    this.enabled = !!(on && this.key && this.key.startsWith('sk_'))
    if (on && this.key && !this.key.startsWith('sk_')) {
      this.warn('servers need the secret key (sk_live_...); the public key is for browsers. Not sending.')
    }
    this.flushInterval = Math.max(1000, (o.flushInterval || 5) * 1000)
    this.timeout = (o.timeout || 2) * 1000
    this.logsLevel = o.logsLevel === undefined ? 'WARNING' : o.logsLevel
    this.captureConsole = o.captureConsole === undefined ? true : !!o.captureConsole
    this.captureQueries = o.captureQueries === undefined ? true : !!o.captureQueries
    this.captureHttp = o.captureHttp === undefined ? true : !!o.captureHttp
    this.ignorePaths = o.ignorePaths || ['/health', '/healthz', '/up', '/favicon.ico', '/metrics', '/_next/', '/__nextjs', '/robots.txt']
    this.healthChecks = { ...(o.healthChecks || {}) }
    this.healthInterval = (o.healthInterval || 60) * 1000
    // The server's CPU, memory and disk, so LoggerAI can say "CPU hit 97%" when the app slows down.
    this.hostMetrics = o.hostMetrics === undefined ? truthy(env('LOGGERAI_HOST_METRICS', 'true')) : !!o.hostMetrics
    this.hostInterval = Math.max(10, o.hostInterval || 30) * 1000
    this.root = o.root || process.cwd()
    this.host = os.hostname()
    // On Vercel or Lambda the function may freeze right after answering: send at the end of each request.
    this.serverless = o.serverless === undefined ? !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) : !!o.serverless
    this.debug = truthy(env('LOGGERAI_DEBUG', 'false'))
    this.buf = Object.fromEntries(KINDS.map((k) => [k, []]))
    this.fallbackRoutes = new Set()
    this.timer = null
    this.sending = null
    this.nextHealth = 0
    this.nextHost = 0
    this.sampler = null
    this.lastError = null
    this.stopped = false
    try {
      const u = new URL(this.endpoint)
      this.endpointHost = `${u.hostname}:${u.port || (u.protocol === 'https:' ? 443 : 80)}`
    } catch {
      this.endpointHost = ''
    }
  }

  /** True for a call to LoggerAI itself (host and port), which is never recorded. */
  isSelf(hostname, port) {
    return `${hostname}:${port}` === this.endpointHost
  }

  warn(msg) {
    process.stderr.write(`LoggerAI: ${msg}\n`)
  }

  // ---- recording ------------------------------------------------------------------------

  ignored(path) {
    const p = String(path || '').split('?')[0]
    return this.ignorePaths.some((i) => p === i || (i.endsWith('/') ? p.startsWith(i) : p.startsWith(i + '/')))
  }

  /** A route name from a raw path when the framework didn't name it: ids become {id}. */
  fallbackRoute(rawPath) {
    const p = String(rawPath || '/').split('?')[0].split('#')[0]
    const route = '/' + p.split('/').filter(Boolean).map((s) => (ID_SEGMENT.test(s) ? '{id}' : s.length > 60 ? '{id}' : s)).join('/')
    if (this.fallbackRoutes.has(route)) return route
    if (this.fallbackRoutes.size >= MAX_FALLBACK_ROUTES) return '(other)'
    this.fallbackRoutes.add(route)
    return route
  }

  add(kind, record) {
    if (!this.enabled) return
    const buf = this.buf[kind]
    buf.push(record)
    if (buf.length > MAX_BUFFER) buf.splice(0, buf.length - MAX_BUFFER)
  }

  finish(unit, status) {
    if (unit.finished) return
    unit.finished = true
    this.add('requests', unit.record(status))
    if (this.serverless) this.flushSoon()
  }

  exception(err, { status = null, handled = false, extra = null, route, method } = {}) {
    if (!this.enabled || !err) return
    if (typeof err !== 'object') err = new Error(String(err))
    if (err.__loggeraiSeen) return
    try {
      Object.defineProperty(err, '__loggeraiSeen', { value: true }) // reported once, however many layers see it
    } catch {}
    const unit = ctx.current()
    this.add('errors', {
      ts: Math.round(Date.now()) / 1000,
      type: typeName(err),
      message: redactString(String(err.message || err).slice(0, 1000)),
      handled,
      route: route || (unit && unit.route) || null,
      method: method || (unit && unit.method) || null,
      status,
      trace_id: unit ? unit.traceId : null,
      frames: frames(err, this.root),
      context: extra ? redact(extra) : {},
    })
  }

  log(level, logger, message) {
    const unit = ctx.current()
    this.add('logs', {
      ts: Math.round(Date.now()) / 1000,
      level,
      logger: String(logger).slice(0, 120),
      message: redactString(String(message).slice(0, 8000)),
      route: unit ? unit.route : null,
      trace_id: unit ? unit.traceId : null,
    })
  }

  /** An opaque, stable id for a user: never the id itself, never an email. */
  userRef(id) {
    if (id === null || id === undefined || id === '') return null
    return crypto.createHmac('sha256', this.key || '').update(String(id)).digest('hex').slice(0, 16)
  }

  // ---- sending ----------------------------------------------------------------------------

  start() {
    if (!this.enabled || this.timer || this.stopped) return
    // Outside any request, so the timer doesn't carry a request's context along.
    ctx.store.exit(() => {
      this.timer = setInterval(() => this.tick(), this.flushInterval)
      this.timer.unref()
    })
    this.tick()
  }

  tick() {
    if (this.sending) return this.sending
    this.sending = ctx.store.exit(async () => {
      try {
        await this.runHealth()
        this.runHost()
        await this.sendAll()
      } catch (e) {
        if (this.debug) this.warn(`send failed: ${e && e.message}`)
      } finally {
        this.sending = null
      }
    })
    return this.sending
  }

  flushSoon() {
    const p = this.tick()
    // Keep a serverless function alive until the batch is out.
    try {
      const rc = globalThis[Symbol.for('@vercel/request-context')]
      const waitUntil = rc && rc.get && rc.get() && rc.get().waitUntil
      if (waitUntil) waitUntil(p)
    } catch {}
    return p
  }

  async runHealth() {
    const names = Object.keys(this.healthChecks)
    if (!names.length || Date.now() < this.nextHealth) return
    this.nextHealth = Date.now() + this.healthInterval
    for (const name of names) {
      const t = process.hrtime.bigint()
      let ok = false
      let detail = null
      try {
        const r = await this.healthChecks[name]()
        if (Array.isArray(r)) [ok, detail] = [!!r[0], r[1] == null ? null : String(r[1]).slice(0, 255)]
        else ok = r !== false
      } catch (e) {
        ok = false
        detail = `${typeName(e)}: ${e && e.message}`.slice(0, 255)
      }
      this.add('checks', { ts: Math.round(Date.now()) / 1000, name, ok, ms: Math.round(ctx.since(t) * 100) / 100, detail })
    }
  }

  runHost() {
    if (!this.hostMetrics || Date.now() < this.nextHost) return
    this.nextHost = Date.now() + this.hostInterval
    try {
      if (!this.sampler) {
        const { HostSampler } = require('./host')
        this.sampler = new HostSampler(this.root) // primes the CPU counters; the next sample has CPU
        return
      }
      this.add('hosts', this.sampler.sample())
    } catch (e) {
      if (this.debug) this.warn(`host metrics failed: ${e && e.message}`)
    }
  }

  drain() {
    const out = {}
    for (const k of KINDS) {
      if (this.buf[k].length) out[k] = this.buf[k].splice(0, MAX_PER_BATCH)
    }
    return Object.keys(out).length ? out : null
  }

  async sendAll() {
    for (let i = 0; i < 20; i++) {
      // a burst goes out in several batches, then waits for the next tick
      const parts = this.drain()
      if (!parts || !this.enabled) return
      await this.post(parts)
    }
  }

  body(parts) {
    return JSON.stringify({
      sdk: { name: 'loggerai-node', version: VERSION },
      service: this.service,
      environment: this.environment,
      release: this.release,
      host: this.host,
      ...parts,
    })
  }

  async post(parts) {
    const body = this.body(parts)
    const n = Object.values(parts).reduce((a, v) => a + v.length, 0)
    if (Buffer.byteLength(body) > MAX_BATCH_BYTES && n > 1) {
      for (const half of halves(parts)) await this.post(half)
      return
    }
    const status = await this.send(zlib.gzipSync(body))
    if (status >= 200 && status < 300) {
      this.lastError = null
      return
    }
    this.lastError = status ? `LoggerAI answered ${status}` : this.lastError
    if (status === 401) {
      this.enabled = false // a wrong or revoked key won't start working by retrying
      this.warn('the key was refused (401). Check LOGGERAI_KEY; sending stopped.')
    } else if (status && status !== 429 && status < 500) {
      this.warn(`batch rejected (${status})`)
    }
  }

  send(gz) {
    return new Promise((resolve) => {
      let u
      try {
        u = new URL(this.endpoint)
      } catch {
        this.lastError = 'bad LOGGERAI_ENDPOINT'
        return resolve(0)
      }
      const req = request[u.protocol](u, {
        method: 'POST',
        timeout: this.timeout,
        headers: {
          'Content-Type': 'application/json',
          'Content-Encoding': 'gzip',
          'Content-Length': gz.length,
          'X-LoggerAI-Key': this.key || '',
          'User-Agent': `loggerai-node/${VERSION}`,
        },
      }, (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode))
        res.on('error', () => resolve(res.statusCode))
      })
      req.on('timeout', () => req.destroy(new Error('timed out')))
      req.on('error', (e) => {
        this.lastError = `couldn't reach LoggerAI: ${e.code || e.message}`
        if (this.debug) this.warn(this.lastError)
        resolve(0)
      })
      req.end(gz)
    })
  }

  /** Sends everything recorded so far. True when the buffer is empty. */
  async flush(timeoutMs = 5000) {
    if (!this.enabled) return true
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (this.sending) await Promise.race([this.sending, wait(deadline - Date.now())])
      if (!KINDS.some((k) => this.buf[k].length)) return true
      await Promise.race([this.tick(), wait(deadline - Date.now())])
    }
    return !KINDS.some((k) => this.buf[k].length)
  }

  /** The app is about to die (an uncaught exception): send what's waiting from a child process. */
  flushSync() {
    if (!this.enabled) return
    const parts = this.drain()
    if (!parts) return
    try {
      const script = `const u=new URL(process.env.U);const r=require(u.protocol==='https:'?'https':'http').request(u,{method:'POST',timeout:2500,headers:{'Content-Type':'application/json','Content-Encoding':'gzip','X-LoggerAI-Key':process.env.K}},s=>{s.resume();s.on('end',()=>process.exit(0))});r.on('error',()=>process.exit(1));r.on('timeout',()=>r.destroy());process.stdin.on('data',c=>r.write(c));process.stdin.on('end',()=>r.end())`
      spawnSync(process.execPath, ['-e', script], {
        input: zlib.gzipSync(this.body(parts)),
        env: { U: this.endpoint, K: this.key, PATH: process.env.PATH },
        timeout: 3000,
        stdio: ['pipe', 'ignore', 'ignore'],
      })
    } catch {}
  }

  async close(timeoutMs = 2000) {
    await this.flush(timeoutMs)
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}

function halves(parts) {
  const a = {}
  const b = {}
  for (const [k, v] of Object.entries(parts)) {
    const mid = Math.floor(v.length / 2)
    if (mid) a[k] = v.slice(0, mid)
    if (v.length - mid) b[k] = v.slice(mid)
  }
  return [a, b].filter((x) => Object.keys(x).length)
}

const wait = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)).unref())

module.exports = { Client, DEFAULT_ENDPOINT }
