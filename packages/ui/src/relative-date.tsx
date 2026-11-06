import { daysBetween } from "@transfer/domain";
import { useTranslation } from "react-i18next";
import { formatDate } from "./dates";
import { UI_NAMESPACE } from "./i18n";

/**
 * The relative text of a date (ui-patterns.md, principle 5): a deadline is "in 3 Tagen",
 * "heute fällig" or "seit 2 Tagen überfällig" (overdue from the day after its date; deadlines are
 * inclusive), an event "in 3 Tagen", "heute" or "vor 2 Tagen". `today` is the caller's Berlin
 * date (e.g. the snapshot's), never read here.
 */
export function relativeDate(
  date: string,
  today: string,
  kind: "deadline" | "event",
): { key: string; count?: number } {
  const days = daysBetween(today, date);
  if (days > 0) return { key: "relativeDate.inDays", count: days };
  if (days === 0)
    return { key: kind === "deadline" ? "relativeDate.dueToday" : "relativeDate.today" };
  return {
    key: kind === "deadline" ? "relativeDate.overdue" : "relativeDate.daysAgo",
    count: -days,
  };
}

/** The relative text and, always, the absolute `TT.MM.JJJJ` date. */
export function RelativeDate({
  date,
  today,
  kind = "event",
}: {
  date: string;
  today: string;
  kind?: "deadline" | "event";
}) {
  const { t } = useTranslation(UI_NAMESPACE);
  const { key, count } = relativeDate(date, today, kind);
  return (
    <span className="tp-relative-date">
      {`${String(t(key as never, { count } as never))} · `}
      <time dateTime={date}>{formatDate(date)}</time>
    </span>
  );
}
