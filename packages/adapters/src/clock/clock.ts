import { addDays, isValidIsoDate, type IsoDate } from "@transfer/domain";

/**
 * The current time (ADR-0006, plan 5.8). Domain code, config and jobs never read the system
 * time themselves; they get `today()` (the Europe/Berlin calendar date) or `now()` from here.
 */
export interface Clock {
  now(): Date;
  today(): IsoDate;
}

const berlin = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Berlin",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** The Berlin wall-clock fields of an instant, as a UTC epoch value (seconds precision). */
function berlinWall(epochMs: number): number {
  const parts = Object.fromEntries(
    berlin.formatToParts(epochMs).map((part) => [part.type, Number(part.value)]),
  ) as Record<"year" | "month" | "day" | "hour" | "minute" | "second", number>;
  const { year, month, day, hour, minute, second } = parts;
  return Date.UTC(year, month - 1, day, hour, minute, second);
}

/** Berlin's UTC offset at an instant, in milliseconds. */
function berlinOffset(epochMs: number): number {
  return berlinWall(epochMs) - Math.floor(epochMs / 1000) * 1000;
}

/**
 * The instant whose Berlin wall clock shows `wallMs` (Berlin fields encoded as UTC). Exact
 * outside the DST hour, which run times exclude; there it resolves deterministically.
 */
function fromBerlinWall(wallMs: number): number {
  return wallMs - berlinOffset(wallMs - berlinOffset(wallMs));
}

export function berlinDate(instant: Date): IsoDate {
  return new Date(berlinWall(instant.getTime())).toISOString().slice(0, 10);
}

/**
 * Validates a Berlin local run time `HH:MM`. 02:00–02:59 is rejected: on the last Sundays of
 * March and October that hour doesn't exist or occurs twice (round 9).
 */
export function assertRunTime(time: string): void {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!match) throw new RangeError("Expected a run time HH:MM (Europe/Berlin)");
  if (match[1] === "02") throw new RangeError("Run times from 02:00 to 02:59 are not allowed");
}

/** The instant of `time` (Berlin local) on the Berlin calendar day `day`. */
export function scheduledAt(day: IsoDate, time: string): Date {
  assertRunTime(time);
  if (!isValidIsoDate(day)) throw new RangeError("Expected a real calendar date (YYYY-MM-DD)");
  return new Date(fromBerlinWall(Date.parse(`${day}T${time}:00Z`)));
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }

  today(): IsoDate {
    return berlinDate(this.now());
  }
}

/** A clock that only moves when told to: tests, `--today` runs and `CLOCK=fixed:` (dev). */
export class ManualClock implements Clock {
  #epochMs: number;

  constructor(instant: Date) {
    this.#epochMs = instant.getTime();
  }

  now(): Date {
    return new Date(this.#epochMs);
  }

  today(): IsoDate {
    return berlinDate(this.now());
  }

  set(instant: Date): void {
    this.#epochMs = instant.getTime();
  }

  /** Moves by Berlin calendar days and keeps the Berlin local time, also across DST. */
  advanceDays(days: number): void {
    const wall = berlinWall(this.#epochMs);
    const date = new Date(wall).toISOString().slice(0, 10);
    const timeOfDay = wall - Date.parse(`${date}T00:00:00Z`) + (this.#epochMs % 1000);
    this.#epochMs = fromBerlinWall(Date.parse(`${addDays(date, days)}T00:00:00Z`) + timeOfDay);
  }
}

const FIXED =
  /^fixed:(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))$/;

/** `CLOCK=system` (default) or `CLOCK=fixed:<ISO instant>` (dev and tests only). */
export function createClock(env: { CLOCK?: string; NODE_ENV?: string }): Clock {
  const value = env.CLOCK ?? "system";
  if (value === "system") return new SystemClock();
  const instant = FIXED.exec(value)?.[1];
  const epochMs = instant === undefined ? Number.NaN : Date.parse(instant);
  if (Number.isNaN(epochMs)) {
    throw new Error("Invalid CLOCK: expected system or fixed:<ISO instant>");
  }
  if (env.NODE_ENV === "production") {
    throw new Error("CLOCK=fixed is not allowed with NODE_ENV=production");
  }
  return new ManualClock(new Date(epochMs));
}
