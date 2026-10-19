import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImportBusyError, Slots } from "./slots";

// Slice 2 plan, "Planned in PR 2h" (PR 2h-2; R43, AC-52): at most two parse workers per API
// process, eight waiting requests, a 20 s wait; beyond that `import_busy`.

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("Slots", () => {
  it("runs two at once and lets the next waiting one in, in order", async () => {
    const slots = new Slots({ running: 2, waiting: 8, waitMs: 20_000 });
    const release1 = await slots.acquire();
    const release2 = await slots.acquire();
    const order: number[] = [];
    const third = slots.acquire().then((release) => (order.push(3), release));
    const fourth = slots.acquire().then((release) => (order.push(4), release));
    expect(slots.stats()).toEqual({ running: 2, waiting: 2 });
    release1();
    (await third)();
    release2();
    (await fourth)();
    expect(order).toEqual([3, 4]);
    expect(slots.stats()).toEqual({ running: 0, waiting: 0 });
  });

  it("refuses a request that finds the queue full", async () => {
    const slots = new Slots({ running: 1, waiting: 1, waitMs: 20_000 });
    await slots.acquire();
    const waiting = slots.acquire();
    await expect(slots.acquire()).rejects.toBeInstanceOf(ImportBusyError);
    expect(slots.stats()).toEqual({ running: 1, waiting: 1 });
    void waiting;
  });

  it("refuses a request whose wait expires, and forgets it", async () => {
    const slots = new Slots({ running: 1, waiting: 8, waitMs: 20_000 });
    const release = await slots.acquire();
    const waiting = slots.acquire().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await waiting).toBeInstanceOf(ImportBusyError);
    expect(slots.stats()).toEqual({ running: 1, waiting: 0 });
    // The slot it never got goes to nobody: releasing frees it for the next one.
    release();
    expect(slots.stats()).toEqual({ running: 0, waiting: 0 });
  });

  it("releases a slot once only, however often release is called", async () => {
    const slots = new Slots({ running: 1, waiting: 1, waitMs: 20_000 });
    const release = await slots.acquire();
    release();
    release();
    expect(slots.stats()).toEqual({ running: 0, waiting: 0 });
    await slots.acquire();
    expect(slots.stats()).toEqual({ running: 1, waiting: 0 });
  });
});
