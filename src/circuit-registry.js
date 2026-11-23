'use strict'
const { randomUUID } = require('node:crypto')
const { CircuitBreaker } = require('./circuit')

/** One process registry. Explicit sync retains last-known protection if the API is unavailable. */
class CircuitRegistry {
  constructor({ key, service = 'app', environment = 'staging', endpoint = 'https://loggerapp.ehigiator.com/api/v1', instanceId = randomUUID() }) {
    if (!key || !key.startsWith('sk_')) throw new Error('CircuitRegistry requires a project secret key')
    const url = new URL(endpoint)
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Use HTTPS for the LoggerAI endpoint')
    this.key = key; this.service = service; this.environment = environment; this.instanceId = instanceId
    this.endpoint = endpoint.replace(/\/$/, '') + '/obs/reliability/runtime'
    this.breakers = new Map(); this.policies = new Map(); this.syncing = null
  }
  breaker(target, options) {
    if (!this.breakers.has(target)) {
      if (this.breakers.size >= 200) throw new Error('At most 200 circuit breakers per registry')
      this.breakers.set(target, new CircuitBreaker(target, options))
    }
    return this.breakers.get(target)
  }
  sync() {
    if (this.syncing) return this.syncing
    this.syncing = this._sync().finally(() => { this.syncing = null })
    return this.syncing
  }
  async _request(path, body) {
    const response = await fetch(this.endpoint + path, { method: body ? 'POST' : 'GET', redirect: 'error',
      headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(5000) })
    if (!response.ok) throw new Error(`Circuit sync failed (${response.status})`)
    return response.json()
  }
  async _sync() {
    const query = new URLSearchParams({ service: this.service, environment: this.environment })
    const policies = await this._request('/config?' + query)
    if (!Array.isArray(policies) || policies.length > 200) throw new Error('Invalid circuit policy response')
    for (const policy of policies) {
      const b = this.breakers.get(policy.target)
      if (!b) continue // Never claim enforcement for a dependency without a registered wrapper.
      b.configure({ minimumRequests: policy.minimum_requests, failureRatio: policy.failure_ratio, windowSeconds: policy.window_seconds,
        cooldownSeconds: policy.cooldown_seconds, maxConcurrent: policy.max_concurrent })
      this.policies.set(policy.target, policy)
    }
    const circuits = [...this.policies].map(([target, p]) => ({ ...this.breakers.get(target).snapshot(), policy_id: p.id, revision: p.revision }))
    await this._request('/observations', { instance_id: this.instanceId, service: this.service, environment: this.environment, circuits })
    return circuits.length
  }
  /** Returns a stop function. Failed background sync leaves all local breakers running. */
  start(onError = () => {}) {
    if (this.timer) return () => this.stop()
    const sync = () => this.sync().catch(error => { try { onError(error) } catch {} })
    void sync()
    this.timer = setInterval(sync, 30000); this.timer.unref()
    return () => this.stop()
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null }
}
module.exports = { CircuitRegistry }
