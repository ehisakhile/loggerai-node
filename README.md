# LoggerAI for Node.js

Performance monitoring, errors, logs, health checks and server metrics for
Express, Fastify, NestJS, Next.js and any app on Node's http server, with AI
that explains what went wrong.

- **Every endpoint** timed under its route template (`/orders/:id`,
  `/products/[slug]`): p50/p95/p99, Apdex, status codes, slow and failed requests.
- **What each request waits on**: PostgreSQL (`pg`), MySQL (`mysql2`), Redis
  (`ioredis`), outgoing HTTP (`fetch`, `http`/`https`, axios, got).
- **Exceptions**, grouped by cause, with stack traces that show your code
  first, including crashes (uncaught exceptions and unhandled rejections).
- **Logs** from `console.warn` and `console.error`.
- **Health checks** you define (database, cache, a queue).
- **The server**: CPU, memory and disk every 30 seconds (inside Docker, against
  the container's own limits).
- **Background work** (queue jobs, cron tasks, scripts) timed like requests.
- **Browser sessions** recorded by LoggerAI's browser script link to the
  server request each click caused (`traceparent`, `x-loggerai-session`).

Secrets (passwords, tokens, cookies, API keys, JWTs) are masked before
anything leaves your server, request and response bodies are never sent, and
users are counted by a one-way hash of their id. No dependencies; Node 18.17+.

## Install

```bash
npm install @loggerai/node
```

Get your project's **secret key** (`sk_live_...`) from LoggerAI → your
project → **Connect**, and set it in the environment:

```bash
LOGGERAI_KEY=sk_live_...
LOGGERAI_RELEASE=$GIT_SHA      # optional: "since release X"
```

Without a key nothing is recorded or sent, so local development stays quiet.

Check it can reach LoggerAI from your server (or container):

```bash
npx @loggerai/node test
```

## Turn it on

Call `init()` once, **before** the app starts listening and before your
database clients connect. Everything else is automatic.

### Express (and NestJS)

```js
const loggerai = require('@loggerai/node')
loggerai.init()

const app = express()
// ... your routes ...
app.use(loggerai.expressErrorHandler())   // after the routes: errors with their stack
```

In NestJS, call `loggerai.init()` at the top of `main.ts`. Routes are named on
their own; exceptions your filters handle can be reported with
`loggerai.captureException(err)`.

### Fastify

```js
const loggerai = require('@loggerai/node')
loggerai.init()

const app = Fastify()
await app.register(loggerai.fastify)
```

### Next.js (App Router or Pages, Node and Edge runtimes)

```ts
// instrumentation.ts (next to app/ or in src/)
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const loggerai = await import('@loggerai/node')
    loggerai.init()
  }
}

export async function onRequestError(...args: any[]) {
  const { nextOnRequestError } = await import('@loggerai/node')   // the edge build at the edge
  nextOnRequestError(...(args as Parameters<typeof nextOnRequestError>))
}
```

```js
// next.config.js
module.exports = { serverExternalPackages: ['@loggerai/node'] }
```

Pages and route handlers are named by their file route (`/products/[slug]`,
`/api/orders/[id]`). On Vercel, each request's data is sent before the
function goes to sleep.

**Edge runtime** (`export const runtime = 'edge'`, and middleware): the same
import resolves to a small edge build. Wrap edge route handlers and middleware
so they're timed and their errors reported; each request's data is sent with
`waitUntil` when it ends:

```ts
// app/api/price/[sku]/route.ts
import { withLoggerAI } from '@loggerai/node'
export const runtime = 'edge'
export const GET = withLoggerAI(async (req, { params }) => Response.json(await price((await params).sku)))

// middleware.ts
import { withLoggerAIMiddleware } from '@loggerai/node'
export const middleware = withLoggerAIMiddleware(async (req) => NextResponse.next())
```

Self-hosted (`next start`), Next runs edge code inside the Node server, which
already records it: the edge side then stands aside, so nothing is counted
twice. The edge build also works in Vercel Edge Functions and Cloudflare
Workers (`import { withLoggerAI } from '@loggerai/node/edge'`), using the
`LOGGERAI_KEY` from the environment or `init({ key })`. Server metrics and
health checks are Node-only.

### Anything else on Node's http server (Koa, Hapi, plain `http`)

`loggerai.init()` is enough. When the framework doesn't say which route
matched, ids in the path become `{id}` (`/orders/{id}`); name a request
yourself with `loggerai.setRoute('/orders/:id')`.

## More

```js
// Count requests against a user (only a one-way hash of the id is sent)
loggerai.setUser(user.id)

// An error you handled but still want to see
loggerai.captureException(err, { orderId })

// A call LoggerAI can't see on its own (Prisma, MongoDB, an SDK with its own client)
const rows = await loggerai.measure('postgres', 'SELECT', () => prisma.order.findMany())

// A queue job, cron task or script, timed like a request
await loggerai.track('job', 'SendInvoices', async () => { ... })

// Health checks, every minute
loggerai.healthChecks({
  database: async () => (await pool.query('SELECT 1'), true),
  queue: async () => { const n = await queue.count(); return [n < 1000, `${n} waiting`] },
})

// At the end of a script or a serverless call
await loggerai.flush()
```

## Options

Every option can be passed to `init({...})`; the main ones also read the environment.

| Option | Environment | Default |
| --- | --- | --- |
| `key` | `LOGGERAI_KEY` | none (off) |
| `service` | `LOGGERAI_SERVICE` | `app` |
| `environment` | `LOGGERAI_ENVIRONMENT`, `NODE_ENV` | `production` |
| `release` | `LOGGERAI_RELEASE`, `VERCEL_GIT_COMMIT_SHA` | none |
| `enabled` | `LOGGERAI_ENABLED` | on when a secret key is set |
| `hostMetrics` | `LOGGERAI_HOST_METRICS` | `true` |
| `endpoint` | `LOGGERAI_ENDPOINT` | LoggerAI |
| `logsLevel` | | `'WARNING'` (`null` for no logs) |
| `captureConsole`, `captureQueries`, `captureHttp` | | `true` |
| `ignorePaths` | | `/health`, `/healthz`, `/up`, `/favicon.ico`, `/metrics`, `/_next/` |
| `healthChecks` | | none |
| `serverless` | | on when `VERCEL` or `AWS_LAMBDA_FUNCTION_NAME` is set |
| `flushInterval`, `timeout` | | 5 s, 2 s |

## How it behaves

- Batches go out every 5 seconds from a timer, gzipped, with a 2-second
  timeout. Nothing makes a request wait, and nothing throws into your app.
- When LoggerAI can't be reached, data is dropped rather than piling up in
  memory. A refused key (401) stops sending until the app restarts.
- On `SIGTERM` (deploys, containers stopping) it sends what's left first.

## Development

```bash
npm install
npm test
```

A tag like `v0.1.0` runs the tests and publishes to npm.
