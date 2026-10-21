import type { Clock } from "@transfer/adapters";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";

/**
 * The per-IP throttle of code submissions (Slice 3 plan D14): at most `limit` in a sliding window.
 * In memory, per process: a shared limiter, and the client IP behind the cluster's ingress, are
 * pre-pilot items (ADR-0005). Keys are IPs, never anything a participant typed.
 */
export function createThrottle({
  limit,
  windowMs,
  clock,
}: {
  limit: number;
  windowMs: number;
  clock: Clock;
}) {
  const hits = new Map<string, number[]>();
  return {
    /** Counts one submission; refused ones count too. */
    take(key: string): { ok: true } | { ok: false; retryAfterSeconds: number } {
      const now = clock.now().getTime();
      const recent = (hits.get(key) ?? []).filter((at) => at > now - windowMs);
      recent.push(now);
      hits.set(key, recent);
      // Forget idle keys so the map doesn't grow without bound.
      if (hits.size > 10_000) {
        for (const [other, times] of hits) {
          if (times.every((at) => at <= now - windowMs)) hits.delete(other);
        }
      }
      if (recent.length <= limit) return { ok: true };
      return { ok: false, retryAfterSeconds: Math.ceil((recent[0]! + windowMs - now) / 1000) };
    },
  };
}

export type Throttle = ReturnType<typeof createThrottle>;

/** The peer address of the request; `unknown` where there is no socket (`app.request` in tests). */
export function clientIp(c: Context): string {
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}
