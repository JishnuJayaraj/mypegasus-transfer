import { describe, expect, it } from "vitest";
import { queueDispatch, type DispatchQueue } from "./dispatch";
import type { EvaluateProject } from "./payloads";

// The sweep's queue dispatch (plan 5.9): one project job per project and day, keyed; resolves
// when all completed, rejects when one failed; a duplicate waits for the existing job.
const job = (projectId: string): EvaluateProject => ({
  projectId,
  firstDay: "2025-03-03",
  runDate: "2025-03-03",
});
type State = "created" | "retry" | "active" | "completed" | "cancelled" | "failed";

/** A fake queue whose jobs move through the given states, one per poll. */
function fakeQueue(paths: Record<string, State[]>, existing: Record<string, string> = {}) {
  const sent: { data: object; key: string | undefined }[] = [];
  const polls: Record<string, number> = {};
  const queue: DispatchQueue = {
    send: async (_name, data, options) => {
      sent.push({ data, key: options.singletonKey });
      return options.singletonKey in existing ? null : `job-${options.singletonKey}`;
    },
    findJobs: async (_name, options) => {
      if (options.key) return [{ id: existing[options.key]!, state: "active" }];
      const id = options.id!;
      const path = paths[id]!;
      const n = (polls[id] = (polls[id] ?? -1) + 1);
      return [{ id, state: path[Math.min(n, path.length - 1)]! }];
    },
  };
  return { queue, sent };
}

const options = { pollMs: 1, maxPolls: 10 };

describe("queueDispatch", () => {
  it("sends one job per project with the key <projectId>:<runDate> and waits for all", async () => {
    const { queue, sent } = fakeQueue({
      "job-p1:2025-03-03": ["created", "active", "completed"],
      "job-p2:2025-03-03": ["completed"],
    });
    await queueDispatch(queue, options)([job("p1"), job("p2")]);
    expect(sent.map((s) => s.key)).toEqual(["p1:2025-03-03", "p2:2025-03-03"]);
    expect(sent[0]!.data).toEqual(job("p1"));
  });

  it("waits for the existing job when the key is taken", async () => {
    const { queue } = fakeQueue(
      { earlier: ["active", "completed"] },
      { "p1:2025-03-03": "earlier" },
    );
    await expect(queueDispatch(queue, options)([job("p1")])).resolves.toBeUndefined();
  });

  it.each(["failed", "cancelled"] as const)("rejects when a project job %s", async (state) => {
    const { queue } = fakeQueue({
      "job-p1:2025-03-03": ["completed"],
      "job-p2:2025-03-03": ["active", "retry", state],
    });
    await expect(queueDispatch(queue, options)([job("p1"), job("p2")])).rejects.toMatchObject({
      code: "project_job_failed",
    });
  });

  it("gives up after the maximum number of polls", async () => {
    const { queue } = fakeQueue({ "job-p1:2025-03-03": ["active"] });
    await expect(queueDispatch(queue, options)([job("p1")])).rejects.toMatchObject({
      code: "project_jobs_timeout",
    });
  });

  it("rejects when a taken key has no job to wait for", async () => {
    const { queue } = fakeQueue({}, { "p1:2025-03-03": "gone" });
    queue.findJobs = async () => [];
    await expect(queueDispatch(queue, options)([job("p1")])).rejects.toMatchObject({
      code: "project_job_missing",
    });
  });
});
