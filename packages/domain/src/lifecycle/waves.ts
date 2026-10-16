import { laterIsoDate } from "../dates";
import type { IsoDate } from "../iso-date";

/**
 * An entry wave of a `ta_tg` project (Q79): its contractual dates, nullable while draft.
 * Deadlines are inclusive; the cutoff is the Berlin day after `latestEntryDate` (Q77).
 */
export type EntryWave = {
  id: string;
  code: string;
  signingDeadline: IsoDate | null;
  defaultTgStart: IsoDate | null;
  defaultTgEnd: IsoDate | null;
  latestEntryDate: IsoDate | null;
};

/** A participation's own contractual dates; `null` means the wave default applies. */
export type ParticipationDates = {
  tgStart: IsoDate | null;
  tgEnd?: IsoDate | null;
  offerDeadline: IsoDate | null;
};

export function effectiveTgStart(p: ParticipationDates, wave: EntryWave | null): IsoDate | null {
  return p.tgStart ?? wave?.defaultTgStart ?? null;
}

export function effectiveTgEnd(p: ParticipationDates, wave: EntryWave | null): IsoDate | null {
  return p.tgEnd ?? wave?.defaultTgEnd ?? null;
}

/** The deadline of the current offer: a re-offer's own, else the wave's signing deadline. */
export function effectiveOfferDeadline(
  p: ParticipationDates,
  wave: EntryWave | null,
): IsoDate | null {
  return p.offerDeadline ?? wave?.signingDeadline ?? null;
}

/**
 * The latest `latestEntryDate` across the project's waves (Q84), derived only when every wave
 * has one: while one is missing, a later date may still come (round 9, note 2).
 */
export function projectFinalEntryDate(waves: readonly EntryWave[]): IsoDate | null {
  const dates = waves.map((w) => w.latestEntryDate);
  if (dates.length === 0 || dates.some((d) => d === null)) return null;
  return (dates as IsoDate[]).reduce((a, b) => laterIsoDate(a, b));
}
