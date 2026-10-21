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
 * staff user id or, on portal routes, the participation id (Slice 3 plan, API). Never bodies,
 * query strings, cookies or headers (CLAUDE.md rule 9).
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
      participationId: c.get("participant")?.participationId,
    });
  };
}

/** A V8 stack frame: `at <where> (<file>:<line>:<col>)` or `at <file>:<line>:<col>`. */
const stackFrame = /^\s+at .+:\d+:\d+\)?$/;

/**
 * The stack frames of an error without its message, which may contain personal data (CLAUDE.md
 * rule 9). The stack starts with `name: message`, which may span lines (round 21): that head is
 * cut off exactly, and of the rest only lines shaped like frames are kept.
 */
export function errorForLog(error: unknown) {
  if (!(error instanceof Error)) return { name: typeof error };
  const head = `${error.name}: ${error.message}`;
  const body = error.stack?.startsWith(head) ? error.stack.slice(head.length) : error.stack;
  return {
    name: error.name,
    code: (error as { code?: unknown }).code,
    stack: body
      ?.split("\n")
      .filter((line) => stackFrame.test(line))
      .join("\n"),
  };
}
