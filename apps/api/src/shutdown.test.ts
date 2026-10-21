import { pino } from "pino";
import { describe, expect, it, vi } from "vitest";
import { createShutdown } from "./shutdown";

// Round 19: single-flight; stop accepting requests, await HTTP draining and pg-boss's graceful
// stop, only then close the pool; failures sanitized and reported.

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function targets() {
  const logs: string[] = [];
  const order: string[] = [];
  const http = deferred();
  const jobsStopped = deferred();
  const server = {
    close: vi.fn<(callback: (error?: Error) => void) => void>((callback) => {
      order.push("http:close");
      http.promise.then(
        () => callback(),
        (error: Error) => callback(error),
      );
    }),
  };
  const jobs = {
    stop: vi.fn<() => Promise<void>>(() => {
      order.push("jobs:stop");
      return jobsStopped.promise;
    }),
  };
  const pool = {
    end: vi.fn<() => Promise<void>>(async () => {
      order.push("pool:end");
    }),
  };
  const logger = pino({ level: "info" }, { write: (line: string) => logs.push(line) });
  return { server, jobs, pool, logger, logs, order, http, jobsStopped };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("createShutdown", () => {
  it("closes the pool only after the detached sends finished (login codes, D27)", async () => {
    const t = targets();
    const sent = deferred();
    const detached = { settle: vi.fn<() => Promise<void>>(() => sent.promise) };
    const done = createShutdown({ ...t, detached })("SIGTERM");
    t.http.resolve();
    t.jobsStopped.resolve();
    await tick();
    expect(t.pool.end).not.toHaveBeenCalled();
    sent.resolve();
    expect(await done).toBe(true);
    expect(t.order.at(-1)).toBe("pool:end");
  });

  it("closes the pool only after the HTTP requests drained and pg-boss stopped", async () => {
    const t = targets();
    const done = createShutdown(t)("SIGTERM");
    await tick();
    expect(t.order).toEqual(["http:close", "jobs:stop"]);
    t.jobsStopped.resolve();
    await tick();
    expect(t.pool.end).not.toHaveBeenCalled();
    t.http.resolve();
    expect(await done).toBe(true);
    expect(t.order).toEqual(["http:close", "jobs:stop", "pool:end"]);
    const messages = t.logs.map((line) => JSON.parse(line).msg);
    expect(messages).toEqual(["api stopping", "api stopped"]);
  });

  it("is single-flight: a second signal joins the running shutdown", async () => {
    const t = targets();
    const shutdown = createShutdown(t);
    const first = shutdown("SIGTERM");
    const second = shutdown("SIGINT");
    expect(second).toBe(first);
    t.http.resolve();
    t.jobsStopped.resolve();
    await first;
    expect(t.server.close).toHaveBeenCalledTimes(1);
    expect(t.jobs.stop).toHaveBeenCalledTimes(1);
    expect(t.pool.end).toHaveBeenCalledTimes(1);
  });

  it("works without jobs", async () => {
    const t = targets();
    const done = createShutdown({ ...t, jobs: undefined })("SIGTERM");
    t.http.resolve();
    expect(await done).toBe(true);
    expect(t.order).toEqual(["http:close", "pool:end"]);
  });

  it("reports a failed step without its message and still closes the pool", async () => {
    const t = targets();
    const done = createShutdown(t)("SIGTERM");
    t.http.reject(new Error("request for participant 4711 still open"));
    t.jobsStopped.reject(Object.assign(new Error("secret detail"), { code: "57P01" }));
    expect(await done).toBe(false);
    expect(t.pool.end).toHaveBeenCalledTimes(1);
    const failures = t.logs.map((line) => JSON.parse(line)).filter((l) => l.level === 50);
    expect(failures.map((l) => [l.step, l.error.name, l.error.code])).toEqual([
      ["http", "Error", undefined],
      ["jobs", "Error", "57P01"],
    ]);
    expect(t.logs.join("\n")).not.toMatch(/participant 4711|secret detail/);
  });

  it("reports a pool that fails to close", async () => {
    const t = targets();
    t.pool.end.mockRejectedValueOnce(new Error("pool detail"));
    const done = createShutdown(t)("SIGTERM");
    t.http.resolve();
    t.jobsStopped.resolve();
    expect(await done).toBe(false);
    expect(t.logs.join("\n")).toMatch(/"step":"database"/);
    expect(t.logs.join("\n")).not.toMatch(/pool detail/);
  });
});
