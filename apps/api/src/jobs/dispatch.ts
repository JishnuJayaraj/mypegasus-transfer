import { setTimeout as sleep } from "node:timers/promises";
import { JobError } from "./errors";
import type { Dispatch } from "./lifecycle-sweep";
import { jobNames } from "./names";

/** The part of pg-boss the dispatch uses (a `PgBoss` instance satisfies it). */
export type DispatchQueue = {
  send(name: string, data: object, options: { singletonKey: string }): Promise<string | null>;
  findJobs(
    name: string,
    options: { id?: string; key?: string },
  ): Promise<{ id: string; state: string }[]>;
};

const pending = new Set(["created", "retry", "active"]);

/**
 * The sweep's dispatch through pg-boss (plan 5.9): one `lifecycle.evaluate-project` job per
 * project with `singletonKey` `<projectId>:<runDate>` on the exclusive queue (round 19). A taken
 * key means a job for that project and day is already queued or running (an earlier attempt of
 * this sweep): the sweep waits for that one instead. Resolves once every job completed; rejects as
 * soon as one failed for good or was cancelled, or after `maxPolls`, so the day isn't recorded.
 */
export function queueDispatch(
  queue: DispatchQueue,
  { pollMs = 1000, maxPolls = 50 * 60 }: { pollMs?: number; maxPolls?: number } = {},
): Dispatch {
  const name = jobNames.evaluateProject;
  return async (jobs) => {
    const ids: string[] = [];
    for (const data of jobs) {
      const singletonKey = `${data.projectId}:${data.runDate}`;
      const id =
        (await queue.send(name, data, { singletonKey })) ??
        (await queue.findJobs(name, { key: singletonKey })).findLast((j) => pending.has(j.state))
          ?.id;
      if (!id) throw new JobError("project_job_missing");
      ids.push(id);
    }
    let waiting = ids;
    for (let poll = 0; poll < maxPolls; poll += 1) {
      const states = await Promise.all(
        waiting.map(async (id) => (await queue.findJobs(name, { id }))[0]?.state),
      );
      if (states.some((state) => state === "failed" || state === "cancelled" || !state)) {
        throw new JobError("project_job_failed");
      }
      waiting = waiting.filter((_id, i) => states[i] !== "completed");
      if (waiting.length === 0) return;
      await sleep(pollMs);
    }
    throw new JobError("project_jobs_timeout");
  };
}
