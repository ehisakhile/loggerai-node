'use strict'
const { performance } = require('node:perf_hooks')

class CircuitOpenError extends Error {
  constructor(target) { super(`Circuit open for ${target}`); this.name = 'CircuitOpenError'; this.target = target }
}
class CircuitCapacityError extends Error {
  constructor(target) { super(`Concurrency limit reached for ${target}`); this.name = 'CircuitCapacityError'; this.target = target }
}

/** Opt-in protection. Set actual transport deadlines in fn; no implicit retries or fallbacks. */
class CircuitBreaker {
  constructor(target, options = {}) {
    if (!target || typeof target !== 'string' || target.length > 200) throw new Error('target must contain 1–200 characters')
    this.target = target
    this.clock = options.clock || (() => performance.now())
    this.state = 'closed'; this.generation = 0; this.opened = 0; this.inflight = 0
    this.samples = []; this.blocked = 0; this.capacityBlocked = 0; this.failures = 0; this.calls = 0
    this.configure(options)
  }
  configure(options = {}) {
    const next = { minimumRequests: 10, failureRatio: .5, windowSeconds: 30, cooldownSeconds: 30, maxConcurrent: 100, ...this.options, ...options }
    for (const [key, min, max, integer] of [['minimumRequests', 1, 10000, true], ['failureRatio', .01, 1, false], ['windowSeconds', 1, 3600, false], ['cooldownSeconds', 1, 3600, false], ['maxConcurrent', 1, 10000, true]]) {
      if (!Number.isFinite(next[key]) || next[key] < min || next[key] > max || (integer && !Number.isInteger(next[key]))) throw new Error(`Invalid ${key}`)
    }
    this.options = next
  }
  _enter() {
    const now = this.clock()
    if (this.state === 'open' && now - this.opened >= this.options.cooldownSeconds * 1000) { this.state = 'half_open'; this.generation++ }
    if (this.state === 'open' || (this.state === 'half_open' && this.probe)) { this.blocked++; throw new CircuitOpenError(this.target) }
    if (this.inflight >= this.options.maxConcurrent) { this.capacityBlocked++; throw new CircuitCapacityError(this.target) }
    if (this.state === 'half_open') this.probe = true
    this.inflight++; this.calls++
    return this.generation
  }
  _finish(generation, ok) {
    this.inflight--
    if (!ok) this.failures++
    if (generation !== this.generation) return
    const now = this.clock()
    if (this.state === 'half_open') {
      this.probe = false; this.generation++; this.samples = []
      this.state = ok ? 'closed' : 'open'; this.opened = now
      return
    }
    this.samples = this.samples.filter(s => s[0] > now - this.options.windowSeconds * 1000)
    this.samples.push([now, ok]); if (this.samples.length > 10000) this.samples.shift()
    const failed = this.samples.reduce((n, s) => n + (s[1] ? 0 : 1), 0)
    if (this.samples.length >= this.options.minimumRequests && failed / this.samples.length >= this.options.failureRatio) {
      this.state = 'open'; this.opened = now; this.generation++
    }
  }
  async call(fn, isSuccess = () => true) {
    const generation = this._enter()
    let ok = false
    try { const result = await fn(); ok = Boolean(isSuccess(result)); return result }
    finally { this._finish(generation, ok) }
  }
  snapshot() {
    return { target: this.target, state: this.state, calls: this.calls, failures: this.failures,
      blocked: this.blocked, capacity_blocked: this.capacityBlocked, inflight: this.inflight }
  }
}
module.exports = { CircuitBreaker, CircuitOpenError, CircuitCapacityError }
