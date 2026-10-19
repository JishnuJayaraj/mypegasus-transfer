import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImportFileError } from "./errors";
import { parseSpreadsheet, type ParseDeps } from "./parse";
import { Slots } from "./slots";

// Slice 2 plan R43 (review of PR 2h-2): a worker's slot is handed on only once the worker has
// stopped, so a timed-out worker and its replacement never hold memory at the same time.

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** A stand-in worker whose termination the test completes. */
function fakeWorker() {
  const events = new EventEmitter();
  let stopped!: () => void;
  const terminated = new Promise<number>((resolve) => (stopped = () => resolve(1)));
  const worker = Object.assign(events, {
    terminate: vi.fn<() => Promise<number>>(() => terminated),
  });
  return { worker, stop: () => stopped() };
}

const request = { bytes: Buffer.from("Personalnummer\nBSP-0001\n") };

describe("parse-worker slots (R43)", () => {
  it("hands a timed-out worker's slot on only after the worker has stopped", async () => {
    const first = fakeWorker();
    const second = fakeWorker();
    const spawn = vi
      .fn<ParseDeps["spawn"]>()
      .mockReturnValueOnce(first.worker as never)
      .mockReturnValueOnce(second.worker as never);
    const deps: ParseDeps = {
      slots: new Slots({ running: 1, waiting: 1, waitMs: 60_000 }),
      spawn,
      timeoutMs: 15_000,
    };
    const timedOut = parseSpreadsheet(request, deps).catch((error: unknown) => error);
    const next = parseSpreadsheet(request, deps);
    await vi.advanceTimersByTimeAsync(15_000);
    // Terminating, not yet stopped: still one worker running, the next one waits.
    expect(first.worker.terminate).toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(deps.slots.stats()).toEqual({ running: 1, waiting: 1 });
    first.stop();
    const error = await timedOut;
    expect(error).toBeInstanceOf(ImportFileError);
    expect((error as ImportFileError).code).toBe("file_too_complex");
    await vi.advanceTimersByTimeAsync(0);
    expect(spawn).toHaveBeenCalledTimes(2);
    second.worker.emit("message", { ok: true, result: { sheets: [] } });
    second.stop();
    expect(await next).toEqual({ sheets: [] });
    expect(deps.slots.stats()).toEqual({ running: 0, waiting: 0 });
  });

  it("settles a worker that exited on its own without waiting further", async () => {
    const exited = fakeWorker();
    const deps: ParseDeps = {
      slots: new Slots({ running: 1, waiting: 0, waitMs: 1 }),
      spawn: () => exited.worker as never,
      timeoutMs: 15_000,
    };
    const parsed = parseSpreadsheet(request, deps).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    exited.worker.emit("exit", 1);
    exited.stop();
    expect(await parsed).toBeInstanceOf(ImportFileError);
    expect(deps.slots.stats()).toEqual({ running: 0, waiting: 0 });
  });
});
