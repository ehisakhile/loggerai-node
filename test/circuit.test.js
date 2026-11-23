'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { CircuitBreaker, CircuitOpenError, CircuitCapacityError } = require('../src/circuit')

test('fails fast, limits half-open probes and recovers without retrying a call', async () => {
  let now = 0, calls = 0
  const b = new CircuitBreaker('payments', { minimumRequests: 2, failureRatio: .5, cooldownSeconds: 1, clock: () => now })
  const fail = () => { calls++; throw new Error('offline') }
  await assert.rejects(b.call(fail), /offline/)
  await assert.rejects(b.call(fail), /offline/)
  await assert.rejects(b.call(fail), CircuitOpenError)
  assert.equal(calls, 2)
  now = 1001
  let finish
  const pending = b.call(() => new Promise(resolve => { finish = resolve }))
  await assert.rejects(b.call(() => 1), CircuitOpenError)
  assert.equal(b.snapshot().state, 'half_open')
  finish('ok'); assert.equal(await pending, 'ok')
  assert.equal(b.snapshot().state, 'closed')
  assert.equal(b.snapshot().blocked, 2)
})

test('stale successful calls cannot close a circuit opened by another call', async () => {
  const b = new CircuitBreaker('db', { minimumRequests: 1 })
  let finish
  const old = b.call(() => new Promise(resolve => { finish = resolve }))
  await assert.rejects(b.call(() => { throw new Error('offline') }))
  finish('ok'); await old
  assert.equal(b.snapshot().state, 'open')
})

test('capacity refusal does not count as an upstream failure and failed responses count explicitly', async () => {
  const b = new CircuitBreaker('api', { minimumRequests: 1, maxConcurrent: 1 })
  let finish
  const pending = b.call(() => new Promise(resolve => { finish = resolve }))
  await assert.rejects(b.call(() => 1), CircuitCapacityError)
  finish(200); await pending
  assert.equal(b.snapshot().failures, 0)
  assert.equal(await b.call(() => 503, status => status < 500), 503)
  assert.equal(b.snapshot().state, 'open')
})

test('expired failures do not open the circuit and invalid configuration is rejected', async () => {
  let now = 0
  const b = new CircuitBreaker('api', { minimumRequests: 2, windowSeconds: 1, clock: () => now })
  await assert.rejects(b.call(() => { throw new Error('x') }))
  now = 2000
  await b.call(() => true)
  assert.equal(b.snapshot().state, 'closed')
  assert.throws(() => new CircuitBreaker('api', { failureRatio: 0 }), /failureRatio/)
})
