'use strict'
// The edge entry on its own, as on Vercel Edge or Cloudflare: no Node server around it.
const test = require('node:test')
const assert = require('node:assert')
const http = require('node:http')
const zlib = require('node:zlib')

globalThis.AsyncLocalStorage = require('node:async_hooks').AsyncLocalStorage // edge runtimes have it globally
delete process.env.LOGGERAI_NODE_SERVER

const batches = []
const ingest = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const raw = Buffer.concat(chunks)
    batches.push({ gzip: req.headers['content-encoding'] === 'gzip', body: JSON.parse((req.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(raw) : raw).toString()) })
    res.writeHead(202).end('{}')
  })
})
const upstream = http.createServer((req, res) => res.writeHead(req.url === '/down' ? 503 : 200).end('ok'))
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)))
const all = (kind) => batches.flatMap((b) => b.body[kind] || [])

let edge
let up
test.before(async () => {
  const port = await listen(ingest)
  up = await listen(upstream)
  edge = require('../src/edge')
  edge.init({ key: 'sk_live_edge', endpoint: `http://127.0.0.1:${port}/ingest/batch`, service: 'web', host: 'iad1' })
})
test.after(() => {
  ingest.close()
  upstream.close()
})

test('route handlers: timed, named from params, with fetch calls, sent gzipped when they end', async () => {
  const waits = []
  const GET = edge.withLoggerAI(async (req, { params }) => {
    const { id } = await params
    edge.setUser(id)
    await fetch(`http://127.0.0.1:${up}/ok`)
    await fetch(`http://localhost:${up}/down`)
    return Response.json({ id })
  })
  const res = await GET(new Request('http://x/api/orders/42', { headers: { traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' } }), {
    params: Promise.resolve({ id: '42' }),
    waitUntil: (p) => waits.push(p),
  })
  assert.equal(res.status, 200)
  assert.equal(waits.length, 1, 'the send is handed to waitUntil')
  await Promise.all(waits)
  const r = all('requests')[0]
  assert.equal(r.route, '/api/orders/[id]')
  assert.equal(r.status, 200)
  assert.equal(r.trace_id, '4bf92f3577b34da6a3ce929d0e0e4736')
  assert.equal(r.user.length, 16)
  assert.ok(r.deps.some((d) => d.target === '127.0.0.1' && d.errors === 0))
  assert.ok(r.deps.some((d) => d.target === 'localhost' && d.errors === 1))
  assert.ok(batches[0].gzip)
  assert.equal(batches[0].body.sdk.name, 'loggerai-node-edge')
  assert.equal(batches[0].body.host, 'iad1')
})

test('errors, middleware and the Next.js error hook', async () => {
  const GET = edge.withLoggerAI(async () => {
    throw new TypeError('price missing for sku 7')
  }, '/api/price')
  await assert.rejects(GET(new Request('http://x/api/price'), {}))
  const mw = edge.withLoggerAIMiddleware(async () => {
    throw new Error('geo lookup failed')
  })
  await assert.rejects(mw(new Request('http://x/'), { waitUntil: () => {} }))
  await edge.nextOnRequestError(new Error('render failed'), { path: '/p/1', method: 'GET', headers: {} }, { routePath: '/p/[id]/page', routerKind: 'App Router' })
  await edge.flush()
  const errors = all('errors')
  const price = errors.find((e) => e.type === 'TypeError')
  assert.equal(price.route, '/api/price')
  assert.equal(price.status, 500)
  assert.ok(errors.some((e) => e.message === 'geo lookup failed' && e.route === 'middleware'))
  assert.ok(errors.some((e) => e.message === 'render failed' && e.route === '/p/[id]'))
  assert.ok(all('requests').some((r) => r.route === '/api/price' && r.status === 500))
  assert.ok(!all('requests').some((r) => r.route === 'middleware'), 'middleware is not a request of its own')
})

test('inside a Node server that already records, it stands aside', async () => {
  process.env.LOGGERAI_NODE_SERVER = '1'
  const before = all('requests').length
  const GET = edge.withLoggerAI(async () => new Response('ok'))
  await GET(new Request('http://x/a'), {})
  await edge.flush()
  delete process.env.LOGGERAI_NODE_SERVER
  assert.equal(all('requests').length, before)
})
