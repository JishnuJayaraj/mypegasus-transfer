import type { Logger } from "pino";
import { errorForLog } from "./logger";

/**
 * Work a request starts and doesn't wait for: the send of a login code (ADR-0007), so the
 * `202` comes back alike whether or not the address has an account. The secret lives only in the
 * task's closure, never in a job payload (ADR-0011). Failures are logged without their message
 * (CLAUDE.md rule 9); shutdown and tests wait for the tasks in flight.
 */
export function createDetached(logger: Logger) {
  const running = new Set<Promise<void>>();
  return {
    run(task: string, work: () => Promise<void>) {
      const done: Promise<void> = work()
        .catch((error: unknown) => {
          logger.error({ task, error: errorForLog(error) }, "detached task failed");
        })
        .finally(() => running.delete(done));
      running.add(done);
    },
    /** Resolves once every task started so far has finished. */
    async settle() {
      await Promise.all([...running]);
    },
  };
}

export type Detached = ReturnType<typeof createDetached>;
