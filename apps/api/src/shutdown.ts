import type { Logger } from "pino";
import { errorForLog } from "./logger";

export type ShutdownTargets = {
  /** Node's HTTP server: `close` stops accepting and calls back once active requests are done. */
  server: { close(callback: (error?: Error) => void): unknown };
  /** pg-boss, stopped gracefully (active jobs finish); absent with `JOBS_ENABLED=false`. */
  jobs?: { stop(): Promise<void> } | undefined;
  /** Sends a request started and didn't wait for (login codes); their outcome is recorded. */
  detached?: { settle(): Promise<void> } | undefined;
  pool: { end(): Promise<void> };
  logger: Logger;
};

/**
 * The API's graceful shutdown (round 19), single-flight: a second signal joins the running one.
 * Stops accepting requests, waits for the requests in flight, their detached sends and pg-boss's
 * graceful stop, and only then closes the database pool. A failed step is logged without its message (CLAUDE.md
 * rule 9) and doesn't skip the others; the result is `false` when any step failed.
 */
export function createShutdown({ server, jobs, detached, pool, logger }: ShutdownTargets) {
  let running: Promise<boolean> | undefined;

  async function step(name: string, work: () => Promise<void>): Promise<boolean> {
    try {
      await work();
      return true;
    } catch (error) {
      logger.error({ step: name, error: errorForLog(error) }, "shutdown step failed");
      return false;
    }
  }

  async function run(signal: string): Promise<boolean> {
    logger.info({ signal }, "api stopping");
    const drained = await Promise.all([
      step(
        "http",
        () =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
      step("jobs", async () => jobs?.stop()),
      step("detached", async () => detached?.settle()),
    ]);
    const closed = await step("database", () => pool.end());
    const ok = [...drained, closed].every(Boolean);
    logger.info({ signal, ok }, "api stopped");
    return ok;
  }

  return (signal: string): Promise<boolean> => (running ??= run(signal));
}
