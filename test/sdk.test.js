'use strict'
const test = require('node:test')
const assert = require('node:assert')
const http = require('node:http')
const zlib = require('node:zlib')

const loggerai = require('../src/index')
const { redact, redactUrl } = require('../src/redact')
const { frames } = require('../src/frames')
const { HostSampler } = require('../src/host')

// A stand-in for LoggerAI's ingest: keeps every batch it's sent.
const batches = []
let answer = 202
const ingest = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    batches.push({ key: req.headers['x-loggerai-key'], body: JSON.parse(zlib.gunzipSync(Buffer.concat(chunks)).toString()) })
    res.writeHead(answer).end('{}')
  })
})

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)))
const all = (kind) => batches.flatMap((b) => b.body[kind] || [])
const get = (port, path, headers = {}) =>
  new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path, headers }, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => resolve({ status: res.statusCode, body }))
    }).on('error', reject)
  })

let client
let upstream // a service the app calls
let upstreamServer

test.before(async () => {
  const port = await listen(ingest)
  upstreamServer = http.createServer((req, res) => setTimeout(() => res.writeHead(req.url === '/down' ? 503 : 200).end('ok'), 20))
  upstream = await listen(upstreamServer)
  client = loggerai.init({
    key: 'sk_live_test',
    endpoint: `http://127.0.0.1:${port}/ingest/batch`,
    service: 'api',
    release: 'v1',
    quiet: true,
    flushInterval: 60,
    ignorePaths: ['/ingest/', '/health'],
    healthChecks: { database: () => true, queue: () => [false, 'backlog 900'] },
  })
})

test.after(async () => {
  await client.close(100)
  ingest.closeAllConnections()
  ingest.close()
  upstreamServer.closeAllConnections()
  upstreamServer.close()
})

test('a plain http server: timed, named from the path, with its outgoing calls', async () => {
  const app = http.createServer(async (req, res) => {
    if (req.url.startsWith('/orders/')) {
      await new Promise((r) => http.get(`http://127.0.0.1:${upstream}/x`, (rr) => { rr.resume(); rr.on('end', r) }))
      await fetch(`http://localhost:${upstream}/down`).then((r) => r.text())
    }
    res.writeHead(200).end('hi')
  })
  const port = await listen(app)
  await get(port, '/orders/1842?token=abc', { traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01', 'x-loggerai-session': 'sess-1' })
  await get(port, '/health')
  app.closeAllConnections()
  app.close()
  await client.flush(3000)
  const r = all('requests').find((x) => x.route === '/orders/{id}')
  assert.ok(r, JSON.stringify(all('requests')))
  assert.equal(r.method, 'GET')
  assert.equal(r.status, 200)
  assert.equal(r.trace_id, '4bf92f3577b34da6a3ce929d0e0e4736')
  assert.equal(r.session_id, 'sess-1')
  assert.ok(r.duration_ms >= 40, `duration ${r.duration_ms}`)
  const ip = r.deps.find((d) => d.target === '127.0.0.1')
  const local = r.deps.find((d) => d.target === 'localhost')
  assert.ok(ip && ip.count === 1 && ip.errors === 0 && ip.ms >= 15, JSON.stringify(r.deps))
  assert.ok(local && local.op === 'GET' && local.errors === 1, 'fetch to a 503 counts as failed: ' + JSON.stringify(r.deps))
  assert.ok(!all('requests').some((x) => x.route === '/health'), 'ignored paths are not recorded')
  const b = batches.at(-1)
  assert.equal(b.key, 'sk_live_test')
  assert.equal(b.body.sdk.name, 'loggerai-node')
  assert.equal(b.body.service, 'api')
  assert.equal(b.body.release, 'v1')
})

test('express: route templates, nested routers, errors with their stack', async () => {
  const express = require('express')
  const app = express()
  const router = express.Router()
  router.get('/:order', (req, res) => res.json({ ok: true }))
  app.use('/api/orders', router)
  app.get('/boom', () => {
    throw new TypeError('Cannot read properties of undefined (reading total)')
  })
  app.use(loggerai.expressErrorHandler())
  app.use((err, req, res, _next) => res.status(500).send('sorry'))
  const server = http.createServer(app)
  const port = await listen(server)
  await get(port, '/api/orders/77')
  const boom = await get(port, '/boom')
  assert.equal(boom.status, 500)
  server.closeAllConnections()
  server.close()
  await client.flush(3000)
  const reqs = all('requests')
  assert.ok(reqs.some((x) => x.route === '/api/orders/:order' && x.status === 200), JSON.stringify(reqs.map((x) => x.route)))
  assert.ok(reqs.some((x) => x.route === '/boom' && x.status === 500))
  const e = all('errors').find((x) => x.type === 'TypeError')
  assert.ok(e, 'error sent')
  assert.equal(e.route, '/boom')
  assert.equal(e.status, 500)
  assert.ok(e.frames[0].in_app && e.frames[0].file === 'test/sdk.test.js', JSON.stringify(e.frames[0]))
  assert.ok(e.frames.some((f) => !f.in_app), 'library frames are marked')
})

test('fastify: route templates and errors', async () => {
  const Fastify = require('fastify')
  const app = Fastify()
  await app.register(loggerai.fastify)
  app.get('/users/:id', async () => ({ ok: true }))
  app.get('/fail', async () => {
    throw new RangeError('quota went negative')
  })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const port = app.server.address().port
  await get(port, '/users/9')
  await get(port, '/fail')
  await app.close()
  await client.flush(3000)
  const reqs = all('requests')
  assert.ok(reqs.some((x) => x.route === '/users/:id' && x.status === 200), JSON.stringify(reqs.map((x) => x.route)))
  assert.ok(reqs.some((x) => x.route === '/fail' && x.status === 500))
  const e = all('errors').find((x) => x.type === 'RangeError')
  assert.ok(e && e.route === '/fail' && e.status === 500)
})

test('next.js route handlers: the file route from the params', async () => {
  const handler = loggerai.withLoggerAI(async (req) => new Response('ok'))
  await loggerai.track('http', 'outer', async () => {
    await handler(new Request('http://x/api/orders/42/items/7'), { params: Promise.resolve({ id: '42', item: '7' }) })
  })
  const catchAll = loggerai.withLoggerAI(async () => new Response('ok'))
  await catchAll(new Request('http://x/docs/a/b/c'), { params: { slug: ['a', 'b', 'c'] } })
  await client.flush(3000)
  const routes = all('requests').map((x) => x.route)
  assert.ok(routes.includes('/api/orders/[id]/items/[item]'), JSON.stringify(routes))
  assert.ok(routes.includes('/docs/[...slug]'), JSON.stringify(routes))
})

test('jobs, measure, users, console warnings and health checks', async () => {
  await loggerai.track('job', 'SendInvoices', async () => {
    loggerai.setUser(42)
    await loggerai.measure('api.stripe.com', 'POST', () => new Promise((r) => setTimeout(r, 5)))
    console.warn('retrying payment with Authorization: Bearer abcdefghijklmnopqrstuvwxyz')
  })
  await assert.rejects(loggerai.track('job', 'Broken', async () => { throw new Error('nope') }))
  await client.flush(3000)
  const job = all('requests').find((x) => x.route === 'SendInvoices')
  assert.equal(job.kind, 'job')
  assert.equal(job.method, 'JOB')
  assert.equal(job.user.length, 16)
  assert.notEqual(job.user, '42')
  assert.equal(job.deps[0].target, 'api.stripe.com')
  const broken = all('requests').find((x) => x.route === 'Broken')
  assert.equal(broken.status, 500)
  const log = all('logs').find((l) => l.message.includes('retrying payment'))
  assert.equal(log.level, 'WARNING')
  assert.ok(log.message.includes('Bearer [REDACTED]') && !log.message.includes('abcdefghijkl'), log.message)
  const checks = all('checks')
  assert.ok(checks.some((c) => c.name === 'database' && c.ok))
  assert.ok(checks.some((c) => c.name === 'queue' && !c.ok && c.detail === 'backlog 900'))
})

test('redaction', () => {
  const r = redact({ password: 'x', accessToken: 'y', 'X-Api-Key': 'z', nested: { card_number: '4242', fine: 'ok' }, url: 'https://a.b/c?token=1&page=2&key=k' })
  assert.equal(r.password, '[REDACTED]')
  assert.equal(r.accessToken, '[REDACTED]')
  assert.equal(r['X-Api-Key'], '[REDACTED]')
  assert.equal(r.nested.card_number, '[REDACTED]')
  assert.equal(r.nested.fine, 'ok')
  assert.ok(r.url.includes('page=2') && !r.url.includes('token=1') && !r.url.includes('key=k'), r.url)
  assert.ok(!redactUrl('https://user:pw@h.com/x').includes('pw'))
  assert.equal(redact('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'), '[REDACTED_JWT]')
})

test('frames from ESM file URLs and webpack', () => {
  const err = new Error('x')
  err.stack = 'Error: x\n    at OrderService.place (file:///srv/app/src/orders.mjs:12:5)\n    at async Promise.all (index 0)\n    at handler (/srv/app/node_modules/express/lib/router.js:1:1)\n    at node:internal/process/task_queues:95:5'
  const f = frames(err, '/srv/app')
  assert.deepEqual(f[0], { file: 'src/orders.mjs', line: 12, function: 'place', class: 'OrderService', in_app: true })
  assert.equal(f[1].in_app, false)
  assert.equal(f[2].in_app, false)
})

test('server metrics', async () => {
  const s = new HostSampler(process.cwd())
  await new Promise((r) => setTimeout(r, 200))
  const x = s.sample()
  assert.ok(x.cpu_pct >= 0 && x.cpu_pct <= 100, JSON.stringify(x))
  assert.ok(x.mem_used_pct > 0 && x.mem_total_mb > 0)
  assert.ok(x.disk_used_pct > 0)
  assert.ok(x.process_mem_mb > 0)
})

test('a refused key stops sending', async () => {
  answer = 401
  loggerai.log('ERROR', 'one more')
  await client.flush(2000)
  answer = 202
  assert.equal(client.enabled, false)
})
