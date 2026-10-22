import { daysInMonth, isValidIsoDate, type IsoDate } from "./iso-date";

/**
 * Calendar arithmetic on ISO dates (plan 5.1). Pure integer arithmetic, no `Date`, so no time
 * zone or clock can shift a legal date. The current date comes from the `Clock` adapter.
 */

type Ymd = { year: number; month: number; day: number };

function parse(date: IsoDate): Ymd {
  if (!isValidIsoDate(date)) throw new RangeError("Expected a real calendar date (YYYY-MM-DD)");
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return { year, month, day };
}

function format({ year, month, day }: Ymd): IsoDate {
  const date = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  if (!isValidIsoDate(date)) throw new RangeError("Date outside the years 0000-9999");
  return date;
}

function assertInteger(value: number, what: string): void {
  if (!Number.isSafeInteger(value)) throw new RangeError(`Expected a whole number of ${what}`);
}

// Days since 1970-01-01 and back (H. Hinnant's civil-date algorithms).
function toDayNumber({ year, month, day }: Ymd): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  return era * 146097 + yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy - 719468;
}

function fromDayNumber(days: number): Ymd {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const month = mp < 10 ? mp + 3 : mp - 9;
  return {
    year: yoe + era * 400 + (month <= 2 ? 1 : 0),
    month,
    day: doy - Math.floor((153 * mp + 2) / 5) + 1,
  };
}

export function addDays(date: IsoDate, days: number): IsoDate {
  assertInteger(days, "days");
  return format(fromDayNumber(toDayNumber(parse(date)) + days));
}

/** Adds calendar months; a day that doesn't exist in the target month becomes its last day. */
export function addMonths(date: IsoDate, months: number): IsoDate {
  assertInteger(months, "months");
  const { year, month, day } = parse(date);
  const index = year * 12 + (month - 1) + months;
  const target = { year: Math.floor(index / 12), month: (index % 12) + 1 };
  return format({ ...target, day: Math.min(day, daysInMonth(target.year, target.month)) });
}

/** The calendar days from `from` to `to`: negative when `to` lies before `from`. */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  return toDayNumber(parse(to)) - toDayNumber(parse(from));
}

/** ISO dates sort as strings; negative, zero or positive like `Array.prototype.sort`. */
export function compareIsoDates(a: IsoDate, b: IsoDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function laterIsoDate(a: IsoDate, b: IsoDate): IsoDate {
  return compareIsoDates(a, b) >= 0 ? a : b;
}

/** Nationwide parameters of the ASU formula; base defaults supply them (plan 5.7, verify Q1). */
export type AsuDueDateParams = { monthsBeforeEnd: number; daysAfterKnowledge: number };
export const asuDueDateDefaults: AsuDueDateParams = { monthsBeforeEnd: 3, daysAfterKnowledge: 3 };

/**
 * Due date of the Arbeitsuchendmeldung (§38 SGB III, verify Q1): the later of `endDate − 3 months`
 * (month end clamped) and `knowledgeDate + 3 days`. `endDate` is the end of the old employment,
 * `knowledgeDate` when the person learned of it. Drives reminders, never a status change.
 */
export function asuDueDate(
  { endDate, knowledgeDate }: { endDate: IsoDate; knowledgeDate: IsoDate },
  params: AsuDueDateParams = asuDueDateDefaults,
): IsoDate {
  return laterIsoDate(
    addMonths(endDate, -params.monthsBeforeEnd),
    addDays(knowledgeDate, params.daysAfterKnowledge),
  );
}
