// Edge runtimes: Next.js Edge, Vercel Edge Functions, Cloudflare Workers.
export interface EdgeOptions {
  key?: string
  endpoint?: string
  service?: string
  environment?: string
  release?: string
  host?: string
  enabled?: boolean
  /** Time fetch() calls made while serving a request. Default true. */
  captureHttp?: boolean
}
export declare const VERSION: string
export declare function init(options?: EdgeOptions): { enabled: boolean; endpoint: string; service: string; environment: string; release: string | null }
export declare function withLoggerAI<H extends (req: Request, context: any) => any>(handler: H, route?: string): H
export declare function withLoggerAIMiddleware<M extends (req: Request, event?: any) => any>(middleware: M): M
export declare function nextOnRequestError(err: unknown, request: { path: string; method: string; headers: Record<string, string | string[] | undefined> }, context: { routerKind?: string; routePath?: string; routeType?: string; renderSource?: string }): void
export declare function captureException(err: unknown, extra?: Record<string, unknown>): void
export declare function setUser(id: string | number | null | undefined): void
export declare function setRoute(template: string): void
export declare function log(level: 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL', message: string, logger?: string): void
export declare function measure<T>(target: string, operation: string, fn: () => T | Promise<T>): Promise<T>
export declare function flush(): Promise<boolean>
