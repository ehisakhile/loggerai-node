'use strict'
// Microservices: a trace crosses services. Two services in this process (a gateway and an
// orders service on localhost), both recorded, and a stand-in for LoggerAI's ingest.
const test = require('node:test')
const assert = require('node:assert')
const http = require('node:http')
const zlib = require('node:zlib')

const loggerai = require('../src/index')
const ctx = require('../src/context')

const batches = []
const ingest = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    batches.push(JSON.parse(zlib.gunzipSync(Buffer.concat(chunks)).toString()))
    res.writeHead(202).end('{}')
  })
})
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)))
const all = (kind) => batches.flatMap((b) => b[kind] || [])
const seen = [] // headers the orders service received

let client, orders, ordersPort, outside, outsidePort, gateway, gatewayPort

test.before(async () => {
  const port = await listen(ingest)
  client = loggerai.init({ key: 'sk_live_test', endpoint: `http://127.0.0.1:${port}/ingest/batch`, service: 'gateway', quiet: true, flushInterval: 60, hostMetrics: false })
  orders = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers })
    res.writeHead(req.url === '/fail' ? 502 : 200).end('ok')
  })
  ordersPort = await listen(orders)
  // An outside API: reached by a public-looking name, so it must not get the trace.
  outside = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers, outside: true })
    res.writeHead(200).end('ok')
  })
  outsidePort = await listen(outside)
  gateway = http.createServer(async (req, res) => {
    await new Promise((r) => http.get(`http://127.0.0.1:${ordersPort}/orders`, (rr) => { rr.resume(); rr.on('end', r) }))
    await fetch(`http://localhost:${ordersPort}/fail`).then((r) => r.text())
    // An outside API: the propagation rule says no (here for 127.0.0.1; by default for any
    // public host name, tested below), so it gets neither the trace nor this service's name.
    const rule = client.propagates
    client.propagates = () => false
    try {
      await new Promise((r) => http.get(`http://127.0.0.1:${outsidePort}/v1/charges`, (rr) => { rr.resume(); rr.on('end', r) }))
    } finally {
      client.propagates = rule
    }
    res.writeHead(200).end('done')
  })
  gatewayPort = await listen(gateway)
})

test.after(async () => {
  await client.close(100)
  for (const s of [ingest, orders, outside, gateway]) {
    s.closeAllConnections()
    s.close()
  }
})

test('the trace, the caller and each call\'s own span travel to the next service', async () => {
  const incoming = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
  await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: gatewayPort, path: '/checkout', headers: { traceparent: incoming } }, (res) => { res.resume(); res.on('end', resolve) }).on('error', reject)
  })
  await client.flush(3000)
  const reqs = all('requests')
  const gw = reqs.find((r) => r.route === '/checkout')
  assert.ok(gw, JSON.stringify(reqs))
  // The gateway continues the browser's trace, under the browser's span.
  assert.equal(gw.trace_id, '4bf92f3577b34da6a3ce929d0e0e4736')
  assert.equal(gw.parent_span_id, '00f067aa0ba902b7')
  assert.match(gw.span_id, /^[0-9a-f]{16}$/)
  assert.equal(gw.caller, undefined)

  // Both calls to orders carried the trace, each with its own span id, and the gateway's name.
  const toOrders = seen.filter((s) => !s.outside)
  assert.equal(toOrders.length, 2)
  const steps = gw.spans.filter((s) => s.kind === 'client')
  for (const s of toOrders) {
    const p = ctx.parentFrom(s.headers.traceparent)
    assert.equal(p.traceId, gw.trace_id)
    assert.ok(steps.some((st) => st.span_id === p.spanId), `${p.spanId} is one of the gateway's steps`)
    assert.equal(s.headers['x-loggerai-caller'], 'gateway')
  }
  // The orders side (same process, so the same SDK) is a child of the gateway's step.
  const ord = reqs.filter((r) => r.route === '/orders' || r.route === '/fail')
  assert.equal(ord.length, 2)
  for (const r of ord) {
    assert.equal(r.trace_id, gw.trace_id)
    assert.ok(steps.some((st) => st.span_id === r.parent_span_id))
    assert.equal(r.caller, 'gateway')
  }
  assert.equal(steps.find((st) => st.status === 502).ok, false)

  // The outside API got nothing.
  const out = seen.find((s) => s.outside)
  assert.equal(out.headers.traceparent, undefined)
  assert.equal(out.headers['x-loggerai-caller'], undefined)
})

test('queues: traceHeaders on publish, track with headers on consume', async () => {
  let headers
  await loggerai.track('job', 'checkout.publish', async () => {
    headers = loggerai.traceHeaders('orders-queue')
  })
  assert.match(headers.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
  assert.equal(headers['x-loggerai-caller'], 'gateway')
  // Kafka hands headers over as Buffers.
  const kafka = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, Buffer.from(v)]))
  await loggerai.track('job', 'order.created', async () => {}, { headers: kafka })
  await client.flush(3000)
  const reqs = all('requests')
  const pub = reqs.find((r) => r.route === 'checkout.publish')
  const job = reqs.find((r) => r.route === 'order.created')
  assert.equal(job.trace_id, pub.trace_id)
  assert.equal(job.parent_span_id, ctx.parentFrom(headers.traceparent).spanId)
  assert.equal(job.caller, 'gateway')
  assert.equal(job.transport, 'queue')
  assert.equal(pub.spans[0].kind, 'producer')
  assert.equal(pub.spans[0].span_id, job.parent_span_id)
})

test('which hosts get the trace', () => {
  const internal = ctx.propagationRule(undefined, undefined)
  for (const h of ['orders', 'payments.default.svc.cluster.local', 'billing.internal', '10.1.2.3', '172.20.0.5', 'localhost']) assert.equal(internal(h), true, h)
  for (const h of ['api.stripe.com', 'api.openai.com', '8.8.8.8', '']) assert.equal(internal(h), false, h)
  const listed = ctx.propagationRule(['*.acme.io', 'billing.example.com'])
  assert.equal(listed('pay.acme.io'), true)
  assert.equal(listed('acme.io.evil.com'), false)
  assert.equal(listed('billing.example.com'), true)
  assert.equal(ctx.propagationRule(false)('orders'), false)
  assert.equal(ctx.propagationRule(undefined, 'all')('api.stripe.com'), true)
  assert.equal(ctx.callerFrom('<img src=x>'), null)
  assert.equal(ctx.parentFrom('00-00000000000000000000000000000000-00f067aa0ba902b7-01'), null)
})
