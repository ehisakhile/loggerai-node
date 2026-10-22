export interface Options {
  /** The project's secret key (sk_live_...). Default: LOGGERAI_KEY. */
  key?: string
  /** Default: LOGGERAI_ENDPOINT, else LoggerAI's ingest URL. */
  endpoint?: string
  /** Names the process (an API, a worker). Default: LOGGERAI_SERVICE, else "app". */
  service?: string
  /** Default: LOGGERAI_ENVIRONMENT, else NODE_ENV, else "production". */
  environment?: string
  /** Your version or git SHA. Default: LOGGERAI_RELEASE, else VERCEL_GIT_COMMIT_SHA. */
  release?: string
  /** Default: LOGGERAI_ENABLED, else true when a secret key is set. */
  enabled?: boolean
  /** Seconds between batches. Default 5. */
  flushInterval?: number
  /** Seconds to wait for LoggerAI. Default 2. */
  timeout?: number
  /** The lowest console level sent as a log: "WARNING" (default), "ERROR", or null for none. */
  logsLevel?: 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL' | null
  /** console.warn and console.error become logs. Default true. */
  captureConsole?: boolean
  /** Time pg, mysql2 and ioredis calls. Default true. */
  captureQueries?: boolean
  /** Time outgoing HTTP calls and fetch(). Default true. */
  captureHttp?: boolean
  /** Paths not recorded (prefixes; a trailing slash matches everything under it). */
  ignorePaths?: string[]
  /** Checks run every minute: each returns true/false (or a promise), or [ok, detail]. */
  healthChecks?: Record<string, () => unknown>
  healthInterval?: number
  /** The server's CPU, memory and disk. Default: LOGGERAI_HOST_METRICS, else true. */
  hostMetrics?: boolean
  hostInterval?: number
  /** The app's folder, for stack traces and finding pg/mysql2/ioredis. Default: process.cwd(). */
  root?: string
  /** Send at the end of each request (Vercel, Lambda). Default: on when VERCEL or AWS_LAMBDA_FUNCTION_NAME is set. */
  serverless?: boolean
  /** Don't print the startup line. */
  quiet?: boolean
}

export interface Client {
  readonly enabled: boolean
  readonly endpoint: string
  readonly service: string
  readonly environment: string
  readonly release: string | null
  lastError: string | null
  flush(timeoutMs?: number): Promise<boolean>
  close(timeoutMs?: number): Promise<void>
}

export declare const VERSION: string
export declare function init(options?: Options): Client
export declare function getClient(): Client | null
export declare function captureException(err: unknown, extra?: Record<string, unknown>): void
export declare function setUser(id: string | number | null | undefined): void
export declare function setRoute(template: string): void
export declare function measure<T>(target: string, operation: string, fn: () => T): T
export declare function track<T>(kind: 'job' | 'command' | 'http', name: string, fn: () => T): T
export declare function flush(timeoutMs?: number): Promise<boolean>
export declare function healthChecks(checks: Record<string, () => unknown>): void
export declare function log(level: 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL', message: string, logger?: string): void

/** Express: add after your routes. */
export declare function expressErrorHandler(): (err: any, req: any, res: any, next: (err?: any) => void) => void
/** Fastify plugin: `await app.register(fastify)`. */
export declare function fastify(app: any, opts: any, done: (err?: Error) => void): void
/** Next.js instrumentation.ts onRequestError. */
export declare function nextOnRequestError(err: unknown, request: { path: string; method: string; headers: Record<string, string | string[] | undefined> }, context: { routerKind?: string; routePath?: string; routeType?: string; renderSource?: string }): void
/** Next.js route handlers: names the request by its file route and reports errors. */
export declare function withLoggerAI<H extends (req: Request, context: any) => any>(handler: H, route?: string): H
/** Next.js middleware: reports errors it throws. */
export declare function withLoggerAIMiddleware<M extends (req: Request, event?: any) => any>(middleware: M): M
