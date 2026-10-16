import { z } from "zod";

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/**
 * True if `value` is a `YYYY-MM-DD` string that names a real calendar date.
 * Pure arithmetic, no `Date`, so no time zone can shift the result.
 */
export function isValidIsoDate(value: string): boolean {
  const match = ISO_DATE_PATTERN.exec(value);
  if (!match) return false;
  const [, year, month, day] = match.map(Number) as [number, number, number, number];
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

/**
 * A legal/calendar date (deadline, TG start/end, exit) as an ISO `YYYY-MM-DD` string.
 * Legal dates travel as strings and are stored as `date` columns, never as timestamps.
 * Impossible dates (`2027-02-29`, `2026-14-03`) are rejected.
 *
 * No `id` in the metadata on purpose: it's also used as `.nullable()` in responses, and
 * `@hono/zod-openapi` would then make the shared component nullable everywhere (spike S1).
 */
export const isoDate = z
  .string()
  .refine(isValidIsoDate, {
    error: "Expected a real calendar date in the format YYYY-MM-DD",
    params: { code: "invalid_date" },
  })
  .meta({
    description: "A calendar date in the format YYYY-MM-DD (no time, no time zone).",
    format: "date",
    examples: ["2027-03-01"],
  });

export type IsoDate = z.infer<typeof isoDate>;
