// The parse-worker cap (Slice 2 plan, "Planned in PR 2h", R43; round 33): each worker may use
// about 300 MB, so an API process runs at most two at once. Up to eight further requests wait in
// order for at most 20 s; one that finds the queue full, or whose wait expires, is refused with
// `import_busy` (503 with `Retry-After`), never queued without bound.

/** No parse worker became free in time (R43). */
export class ImportBusyError extends Error {
  override readonly name = "ImportBusyError";

  constructor() {
    super("import_busy");
  }
}

type Waiter = { grant: (release: () => void) => void; timer: ReturnType<typeof setTimeout> };

export class Slots {
  private running = 0;
  private readonly queue: Waiter[] = [];

  constructor(private readonly limits: { running: number; waiting: number; waitMs: number }) {}

  /** Resolves with the slot's release once one is free; rejects with `ImportBusyError`. */
  acquire(): Promise<() => void> {
    if (this.running < this.limits.running) {
      this.running += 1;
      return Promise.resolve(this.releaser());
    }
    if (this.queue.length >= this.limits.waiting) return Promise.reject(new ImportBusyError());
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        grant: resolve,
        timer: setTimeout(() => {
          this.queue.splice(this.queue.indexOf(waiter), 1);
          reject(new ImportBusyError());
        }, this.limits.waitMs),
      };
      this.queue.push(waiter);
    });
  }

  stats() {
    return { running: this.running, waiting: this.queue.length };
  }

  /** Hands the slot to the next waiter, else frees it; a second call does nothing. */
  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) {
        clearTimeout(next.timer);
        next.grant(this.releaser());
      } else {
        this.running -= 1;
      }
    };
  }
}

/** The process's slots for the parse worker (R43). */
export const parseSlots = new Slots({ running: 2, waiting: 8, waitMs: 20_000 });
