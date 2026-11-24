'use strict'
// The unit of work in progress (an HTTP request, a job, a command): what it
// waited on, grouped by target and operation, until it finishes. Kept in
// AsyncLocalStorage, so it follows the request through awaits and callbacks.
//
// Traces cross services with W3C traceparent: a unit continues the trace it was
// called with (its parent is the caller's span), every call it makes is a span
// of its own, and calls to the project's other services carry the trace on.

const { AsyncLocalStorage } = require('node:async_hooks')
const crypto = require('node:crypto')

const { isInternalHost, propagationRule } = require('./propagate')

const store = new AsyncLocalStorage()
const TRACEPARENT = /^[0-9a-f]{2}-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/
const MAX_SPANS = 200 // the server keeps this many steps per request
const CALLER = /^[A-Za-z0-9][A-Za-z0-9._:/ -]{0,59}$/

const spanId = () => crypto.randomBytes(8).toString('hex')

/** The kind of step a call is, from its target. */
function stepKind(target) {
  const t = String(target).toLowerCase()
  if (/^(postgres|mysql|mariadb|sqlite|mongodb|sqlserver|mssql)$/.test(t)) return 'db'
  if (/^(redis|memcached)$/.test(t)) return 'cache'
  return 'client'
}

class Unit {
  /** parent: { traceId, spanId } from traceparent; caller: the calling service's name. */
  constructor(kind, method, traceId, sessionId, parent, caller) {
    this.kind = kind
    this.method = method
    this.route = null
    this.traceId = traceId || (parent && parent.traceId) || crypto.randomBytes(16).toString('hex')
    this.spanId = spanId()
    this.parentSpanId = parent && parent.traceId === this.traceId ? parent.spanId : null
    this.caller = callerFrom(caller)
    this.transport = null
    this.sessionId = sessionId || null
    this.user = null
    this.ts = Date.now() / 1000
    this.started = process.hrtime.bigint()
    this.deps = new Map()
    this.spans = []
    this.finished = false
  }

  /** A call this unit made. extra: { spanId, kind, status, name } when the caller knows them. */
  dep(target, op, ms, ok = true, extra = null) {
    const key = `${target}\u0000${op}`
    let d = this.deps.get(key)
    if (!d) this.deps.set(key, (d = { target, op, count: 0, ms: 0, errors: 0 }))
    d.count += 1
    d.ms += ms
    if (!ok) d.errors += 1
    // Calls to other services and queues are kept one by one (they link the trace across services);
    // database and cache calls stay as totals per target, which the server turns into steps.
    const e = extra || {}
    const kind = e.kind || stepKind(target)
    if ((kind === 'client' || kind === 'producer') && this.spans.length < MAX_SPANS) {
      const end = Number(process.hrtime.bigint() - this.started) / 1e6
      this.spans.push({
        span_id: e.spanId || spanId(),
        name: e.name || `${op} ${target}`,
        kind,
        target,
        start_ms: Math.max(0, Math.round((end - ms) * 100) / 100),
        duration_ms: Math.round(ms * 100) / 100,
        ok: !!ok,
        ...(e.status ? { status: e.status } : {}),
      })
    }
  }

  /** The traceparent for a call this unit makes, with that call's own span id. */
  traceparent(childSpanId) {
    return `00-${this.traceId}-${childSpanId}-01`
  }

  record(status) {
    const r = {
      ts: Math.round(this.ts * 1000) / 1000,
      kind: this.kind,
      method: this.method,
      route: this.route || '(unmatched)',
      status: Number(status) || 0,
      duration_ms: Math.round(Number(process.hrtime.bigint() - this.started) / 1e4) / 100,
      trace_id: this.traceId,
      span_id: this.spanId,
      session_id: this.sessionId,
      user: this.user,
      deps: [...this.deps.values()].map((d) => ({ ...d, ms: Math.round(d.ms * 100) / 100 })),
    }
    if (this.parentSpanId) r.parent_span_id = this.parentSpanId
    if (this.caller) r.caller = this.caller
    if (this.transport) r.transport = this.transport
    if (this.spans.length) r.spans = this.spans
    return r
  }
}

const current = () => store.getStore() || null

/** { traceId, spanId } from a W3C traceparent header, if it's well formed. */
function parentFrom(header) {
  const m = TRACEPARENT.exec(String(header || '').trim().toLowerCase())
  if (!m || m[1] === '0'.repeat(32) || m[2] === '0'.repeat(16)) return null
  return { traceId: m[1], spanId: m[2] }
}

/** The trace id from a W3C traceparent header, if it's well formed. */
function traceFrom(header) {
  const p = parentFrom(header)
  return p ? p.traceId : null
}

function callerFrom(value) {
  const v = String(value || '').trim().slice(0, 60)
  return v && CALLER.test(v) ? v : null
}

function sessionFrom(value) {
  const v = String(value || '').trim()
  return v && /^[A-Za-z0-9._:-]+$/.test(v) ? v.slice(0, 64) : null
}

/** Record a call made during the current unit (ignored outside one). */
function dependency(target, op, ms, ok = true, extra = null) {
  const unit = current()
  if (unit && !unit.finished) unit.dep(String(target).slice(0, 120), String(op || '?').slice(0, 20).toUpperCase(), ms, ok, extra)
}

function sqlVerb(sql) {
  const text = typeof sql === 'string' ? sql : (sql && (sql.text || sql.sql)) || ''
  const m = /^[\s(]*([A-Za-z]+)/.exec(text)
  return m ? m[1].toUpperCase().slice(0, 20) : '?'
}

const since = (start) => Number(process.hrtime.bigint() - start) / 1e6

// ---- where the trace is carried on ------------------------------------------------------------

/** The headers that carry the current trace to another service. */
function outgoingHeaders(unit, childSpanId, service) {
  const h = { traceparent: unit.traceparent(childSpanId) }
  if (service) h['x-loggerai-caller'] = service
  if (unit.sessionId) h['x-loggerai-session'] = unit.sessionId
  return h
}

module.exports = {
  Unit, store, current, traceFrom, parentFrom, callerFrom, sessionFrom, dependency, sqlVerb, since, spanId, stepKind,
  isInternalHost, propagationRule, outgoingHeaders, MAX_SPANS,
}
