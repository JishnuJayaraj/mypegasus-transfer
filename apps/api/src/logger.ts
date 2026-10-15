import { randomUUID } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { routePath } from "hono/route";
import { pino, type Logger } from "pino";
import type { AppEnv } from "./context";

export function createLogger(level: string): Logger {
  return pino({ level, base: undefined });
}

/**
 * One JSON line per request: request id, method, route pattern, status, duration and the
 * staff user id. Never bodies, query strings, cookies or headers (CLAUDE.md rule 9).
 */
export function requestLogger(logger: Logger): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const requestId = randomUUID();
    const start = performance.now();
    c.set("requestId", requestId);
    await next();
    c.res.headers.set("X-Request-Id", requestId);
    logger.info({
      requestId,
      method: c.req.method,
      route: routePath(c, -1),
      status: c.res.status,
      durationMs: Math.round(performance.now() - start),
      staffUserId: c.get("staffUser")?.id,
    });
  };
}

/** The stack frames of an error without its message, which may contain personal data. */
export function errorForLog(error: unknown) {
  if (!(error instanceof Error)) return { name: typeof error };
  return {
    name: error.name,
    code: (error as { code?: unknown }).code,
    stack: error.stack?.split("\n").slice(1).join("\n"),
  };
}
