import { addMonths, compareIsoDates } from "../dates";
import type { IsoDate } from "../iso-date";

// The order of the TL 407's row tables (ba-forms.md, row limits; Q41, provisional): sessions
// chronological; education with the school qualification first, then the rest, most recent
// first; the jobs of the last three years, most recent first; languages as given.

export type SessionRow = { date: IsoDate; from: string; to: string };
type Period = { from: IsoDate; to: IsoDate | null };

/** Sessions by date, then start time (`hh:mm` sorts as text). */
export function orderSessions<T extends SessionRow>(rows: readonly T[]): T[] {
  return rows.toSorted(
    (a, b) => compareIsoDates(a.date, b.date) || (a.from < b.from ? -1 : a.from > b.from ? 1 : 0),
  );
}

/** Most recent first: a running row (`to` null) first, then by end and start, latest first. */
function mostRecentFirst(a: Period, b: Period): number {
  if (a.to === null || b.to === null) {
    if (a.to !== b.to) return a.to === null ? -1 : 1;
  } else if (a.to !== b.to) {
    return compareIsoDates(b.to, a.to);
  }
  return compareIsoDates(b.from, a.from);
}

/**
 * Education rows. A row may say it is the school qualification (`kind`); the self-service rows
 * don't yet (Q196), so without it all rows are ordered most recent first.
 */
export function orderEducation<T extends Period & { kind?: "school" | "other" }>(
  rows: readonly T[],
): T[] {
  return rows.toSorted(
    (a, b) => Number(a.kind !== "school") - Number(b.kind !== "school") || mostRecentFirst(a, b),
  );
}

/**
 * The work rows of the last three years before `today` (TL 407 field 40): those running or
 * ending on or after `today − 3 years`, most recent first.
 */
export function recentWork<T extends Period>(rows: readonly T[], today: IsoDate): T[] {
  const since = addMonths(today, -36);
  return rows
    .filter((row) => row.to === null || compareIsoDates(row.to, since) >= 0)
    .toSorted(mostRecentFirst);
}
