'use strict'
// The unit of work in progress (an HTTP request, a job, a command): what it
// waited on, grouped by target and operation, until it finishes. Kept in
// AsyncLocalStorage, so it follows the request through awaits and callbacks.

const { AsyncLocalStorage } = require('node:async_hooks')
const crypto = require('node:crypto')

const store = new AsyncLocalStorage()
const TRACEPARENT = /^[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/

class Unit {
  constructor(kind, method, traceId, sessionId) {
    this.kind = kind
    this.method = method
    this.route = null
    this.traceId = traceId || crypto.randomBytes(16).toString('hex')
    this.sessionId = sessionId || null
    this.user = null
    this.ts = Date.now() / 1000
    this.started = process.hrtime.bigint()
    this.deps = new Map()
    this.finished = false
  }

  dep(target, op, ms, ok = true) {
    const key = `${target}\u0000${op}`
    let d = this.deps.get(key)
    if (!d) this.deps.set(key, (d = { target, op, count: 0, ms: 0, errors: 0 }))
    d.count += 1
    d.ms += ms
    if (!ok) d.errors += 1
  }

  record(status) {
    return {
      ts: Math.round(this.ts * 1000) / 1000,
      kind: this.kind,
      method: this.method,
      route: this.route || '(unmatched)',
      status: Number(status) || 0,
      duration_ms: Math.round(Number(process.hrtime.bigint() - this.started) / 1e4) / 100,
      trace_id: this.traceId,
      session_id: this.sessionId,
      user: this.user,
      deps: [...this.deps.values()].map((d) => ({ ...d, ms: Math.round(d.ms * 100) / 100 })),
    }
  }
}

const current = () => store.getStore() || null

/** The trace id from a W3C traceparent header, if it's well formed. */
function traceFrom(header) {
  const m = TRACEPARENT.exec(String(header || '').trim().toLowerCase())
  return m && m[1] !== '0'.repeat(32) ? m[1] : null
}

function sessionFrom(value) {
  const v = String(value || '').trim()
  return v && /^[A-Za-z0-9._:-]+$/.test(v) ? v.slice(0, 64) : null
}

/** Record a call made during the current unit (ignored outside one). */
function dependency(target, op, ms, ok = true) {
  const unit = current()
  if (unit && !unit.finished) unit.dep(String(target).slice(0, 120), String(op || '?').slice(0, 20).toUpperCase(), ms, ok)
}

function sqlVerb(sql) {
  const text = typeof sql === 'string' ? sql : (sql && (sql.text || sql.sql)) || ''
  const m = /^[\s(]*([A-Za-z]+)/.exec(text)
  return m ? m[1].toUpperCase().slice(0, 20) : '?'
}

const since = (start) => Number(process.hrtime.bigint() - start) / 1e6

module.exports = { Unit, store, current, traceFrom, sessionFrom, dependency, sqlVerb, since }
