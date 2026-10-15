import { isValidIsoDate } from "@transfer/domain";

const DISPLAY_DATE = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/;

/** An ISO `YYYY-MM-DD` date shown as `TT.MM.JJJJ`; empty for a missing date. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const [year, month, day] = iso.split("-");
  return `${day}.${month}.${year}`;
}

/**
 * Parses a `TT.MM.JJJJ` field (single-digit day and month allowed). Impossible dates such as
 * `31.02.2027` or `03.14.1998` are errors, never rolled over to another date.
 */
export function parseDisplayDate(
  text: string,
): { ok: true; value: string | undefined } | { ok: false } {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true, value: undefined };
  const match = DISPLAY_DATE.exec(trimmed);
  if (!match) return { ok: false };
  const [, day, month, year] = match as unknown as [string, string, string, string];
  const iso = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  return isValidIsoDate(iso) ? { ok: true, value: iso } : { ok: false };
}

const timestampFormat = new Intl.DateTimeFormat("de-DE", {
  timeZone: "Europe/Berlin",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/** An event time (UTC) shown in Europe/Berlin as `TT.MM.JJJJ, HH:MM`. */
export function formatTimestamp(iso: string): string {
  return timestampFormat.format(new Date(iso));
}
