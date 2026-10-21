import { ManualClock } from "@transfer/adapters";
import { describe, expect, it } from "vitest";
import { createThrottle } from "./throttle";

describe("the per-IP throttle (D14)", () => {
  it("allows the limit in the window, then refuses until the oldest leaves it", () => {
    const clock = new ManualClock(new Date("2026-10-21T10:00:00.000Z"));
    const throttle = createThrottle({ limit: 3, windowMs: 15 * 60_000, clock });
    for (let i = 0; i < 3; i++) expect(throttle.take("a").ok).toBe(true);
    expect(throttle.take("a")).toEqual({ ok: false, retryAfterSeconds: 900 });
    expect(throttle.take("b").ok).toBe(true);
    clock.set(new Date("2026-10-21T10:10:00.000Z"));
    // A refused submission counts too.
    expect(throttle.take("a")).toEqual({ ok: false, retryAfterSeconds: 300 });
    clock.set(new Date("2026-10-21T10:15:00.001Z"));
    // The four of 10:00 left the window; the refused one of 10:10 still counts.
    expect(throttle.take("a").ok).toBe(true);
    expect(throttle.take("a").ok).toBe(true);
    expect(throttle.take("a").ok).toBe(false);
  });
});
