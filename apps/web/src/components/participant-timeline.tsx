import type { components } from "@transfer/api-client";
import { berlinDate, berlinTime, type DeadlineKind } from "@transfer/domain";
import { Card, formatDate, StatusTag } from "@transfer/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { stepTarget, type StepTarget } from "./open-steps";

// The participant timeline, stage 1 (the plan of Slice 6b, D12): only facts the page already loads
// (the status dates, the contractual dates, the work list's deadlines and appointments), nothing
// sensitive and no request of its own. Inline SVG styled by CSS classes (no inline <style>, so the
// CSP holds) and no chart library. Every marker is a focusable link to the tab or card that holds
// it, with a tooltip on hover and focus; the list below says the same as text, and is what a
// screen reader and the 400 % zoom read (the graphic is hidden below 30rem).

type Detail = components["schemas"]["ParticipationDetail"];
type Item = components["schemas"]["WorklistItem"];
type AppointmentKind = Item["appointments"]["items"][number]["appointmentKind"];
type AppointmentItemKind = Item["appointments"]["items"][number]["kind"];

/** A date of the main status or the contract. */
export type DateKind =
  | "tgEntryDate"
  | "exitDate"
  | "withdrawnOn"
  | "profilingDoneOn"
  | "tgStart"
  | "tgEnd";

export type TimelineFact = { date: string; target: StepTarget } & (
  | { lane: "dates"; kind: DateKind }
  | { lane: "deadlines"; kind: DeadlineKind; state: "overdue" | "upcoming" | null; final?: boolean }
  | {
      lane: "appointments";
      kind: AppointmentKind;
      startsAt: string;
      /** An appointment item (staff work), else the next booking. */
      item: AppointmentItemKind | null;
    }
);

/** The TG period (from the entry or the planned start to the exit or the planned end). */
export type TimelinePhase = { kind: "ta" | "tg"; from: string; to: string };

export interface Timeline {
  facts: TimelineFact[];
  phases: TimelinePhase[];
  /** The axis, `today` included; a single date gets two weeks on each side. */
  from: string;
  to: string;
  today: string;
}

const lanes = ["dates", "deadlines", "appointments"] as const;

const addDays = (date: string, days: number) => {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
};
const dayNumber = (date: string) => Date.parse(`${date}T00:00:00Z`) / 86_400_000;

/**
 * The timeline's facts in date order (the lane's order on a tie), its phases and its axis. The
 * work list's row is optional: without it (a viewer without the work list) only the detail's dates
 * are drawn.
 */
export function timeline(detail: Detail, item: Item | undefined, today: string): Timeline {
  const { dates } = detail;
  const facts: TimelineFact[] = [];
  const add = (fact: TimelineFact | null) => fact && facts.push(fact);
  const date = (kind: DateKind, value: string | null, target: StepTarget) =>
    add(value === null ? null : { lane: "dates", kind, date: value, target });
  const stand: StepTarget = { anchor: "participant-stand" };
  date("tgEntryDate", dates.tgEntryDate, stand);
  date("exitDate", dates.exitDate, stand);
  date("withdrawnOn", dates.withdrawnOn, stand);
  date("profilingDoneOn", dates.profilingDoneOn, { anchor: "participant-stand" });
  // The planned dates only until the actual ones replace them.
  if (dates.tgEntryDate === null)
    date("tgStart", dates.effectiveTgStart, { anchor: "participant-dates" });
  if (dates.exitDate === null && dates.withdrawnOn === null)
    date("tgEnd", dates.effectiveTgEnd, { anchor: "participant-dates" });
  for (const deadline of item?.deadlines ?? []) {
    add({
      lane: "deadlines",
      kind: deadline.kind,
      date: deadline.date,
      state: deadline.state,
      ...(deadline.final !== undefined && { final: deadline.final }),
      target: stepTarget({ tier: 3, source: "deadline", ...deadline }),
    });
  }
  // The DSV's offer deadline when the work list doesn't list it (beyond its 14-day horizon).
  if (
    dates.offerDeadline !== null &&
    !facts.some((f) => f.lane === "deadlines" && f.kind === "offer_deadline")
  ) {
    add({
      lane: "deadlines",
      kind: "offer_deadline",
      date: dates.offerDeadline,
      state: null,
      target: { anchor: "participant-dates" },
    });
  }
  const appointments = item?.appointments;
  for (const open of appointments?.items ?? []) {
    add({
      lane: "appointments",
      kind: open.appointmentKind,
      startsAt: open.startsAt,
      date: berlinDate(open.startsAt),
      item: open.kind,
      target: { tab: "appointments" },
    });
  }
  if (appointments?.next) {
    add({
      lane: "appointments",
      kind: appointments.next.kind,
      startsAt: appointments.next.startsAt,
      date: berlinDate(appointments.next.startsAt),
      item: null,
      target: { tab: "appointments" },
    });
  }
  facts.sort(
    (a, b) => a.date.localeCompare(b.date) || lanes.indexOf(a.lane) - lanes.indexOf(b.lane),
  );

  const tgFrom = dates.tgEntryDate ?? dates.effectiveTgStart;
  const tgTo = dates.exitDate ?? dates.effectiveTgEnd;
  const all = [
    today,
    ...facts.map((f) => f.date),
    ...(tgFrom ? [tgFrom] : []),
    ...(tgTo ? [tgTo] : []),
  ];
  let from = all.reduce((a, b) => (a < b ? a : b));
  let to = all.reduce((a, b) => (a > b ? a : b));
  if (from === to) [from, to] = [addDays(from, -14), addDays(to, 14)];
  const phases: TimelinePhase[] = [];
  if (tgFrom) {
    // The Transferagentur phase up to the TG, when anything happened before it.
    if (from < tgFrom) phases.push({ kind: "ta", from, to: tgFrom });
    phases.push({ kind: "tg", from: tgFrom, to: tgTo ?? to });
  }
  return { facts, phases, from, to, today };
}

/** Where a date sits on the axis, in percent, with a margin at both ends for the markers. */
function position(date: string, from: string, to: string): number {
  const span = dayNumber(to) - dayNumber(from);
  return 2 + ((dayNumber(date) - dayNumber(from)) / span) * 96;
}

const laneY: Record<TimelineFact["lane"], number> = { dates: 44, deadlines: 80, appointments: 116 };
const height = 160;
const axisY = 140;

/** Each kind's shape around (0, 0): a circle, a diamond or a square (never colour alone). */
const shapes: Record<TimelineFact["lane"], string> = {
  dates: "M -7 0 A 7 7 0 1 0 7 0 A 7 7 0 1 0 -7 0 Z",
  deadlines: "M 0 -8 L 8 0 L 0 8 L -8 0 Z",
  appointments: "M -6.5 -6.5 H 6.5 V 6.5 H -6.5 Z",
};

/** A fact's text, its state and the place that holds it, as the tooltip and the list say it. */
function useFactText() {
  const { t } = useTranslation();
  return (fact: TimelineFact): { label: string; state: string | null } => {
    switch (fact.lane) {
      case "dates":
        return { label: t(`participant.timeline.kinds.${fact.kind}`), state: null };
      case "deadlines":
        return {
          label:
            t(`worklist.deadlineKinds.${fact.kind}`) +
            (fact.final ? ` (${t("worklist.deadlineFinal")})` : ""),
          state: fact.state ? t(`worklist.deadlineStates.${fact.state}`) : null,
        };
      case "appointments":
        return {
          label: t("participant.timeline.appointment", {
            kind: t(`appointments.kinds.${fact.kind}`),
            time: berlinTime(fact.startsAt),
          }),
          state: fact.item
            ? t(`worklist.appointmentItems.${fact.item}`)
            : t("participant.timeline.booked"),
        };
    }
  };
}

/** The name of the tab or card a fact links to. */
export function useTargetName() {
  const { t } = useTranslation();
  return (target: StepTarget): string => {
    if ("tab" in target) {
      const key = target.tab === "self-service" ? "selfService" : target.tab;
      return t(`participant.tabs.${key}`);
    }
    return t(`participant.anchors.${target.anchor}`);
  };
}

export function ParticipantTimeline({
  timeline: { facts, phases, from, to, today },
  href,
  onOpen,
  available,
}: {
  timeline: Timeline;
  /** The URL of a target, for the links. */
  href: (target: StepTarget) => string;
  onOpen: (target: StepTarget) => void;
  /** Whether the viewer has the target (a tab or a card); else the fact is text only. */
  available: (target: StepTarget) => boolean;
}) {
  const { t } = useTranslation();
  const text = useFactText();
  const targetName = useTargetName();
  const [active, setActive] = useState<number | null>(null);
  const at = (date: string) => position(date, from, to);
  const todayAt = at(today);
  // Facts on the same day of one lane stack downwards a little, so each stays reachable.
  const offsets = facts.map(
    (fact, index) =>
      facts.slice(0, index).filter((f) => f.lane === fact.lane && f.date === fact.date).length * 6,
  );
  const description = (fact: TimelineFact) => {
    const { label, state } = text(fact);
    return [label, formatDate(fact.date), state].filter(Boolean).join(" · ");
  };
  const shown = active === null ? null : facts[active];
  return (
    <Card
      id="participant-timeline"
      title={t("participant.timeline.title")}
      description={t("participant.timeline.description")}
    >
      {facts.length === 0 ? (
        <p>{t("participant.timeline.empty")}</p>
      ) : (
        <>
          {/* The graphic's axis runs left to right like its SVG coordinates. */}
          <div className="tp-timeline-graphic" dir="ltr">
            <svg
              className="tp-timeline-svg"
              width="100%"
              height={height}
              aria-label={t("participant.timeline.graphic")}
            >
              {phases.map((phase) => (
                <rect
                  key={phase.kind}
                  className={`tp-timeline-phase tp-timeline-phase--${phase.kind}`}
                  x={`${at(phase.from)}%`}
                  width={`${Math.max(at(phase.to) - at(phase.from), 0.5)}%`}
                  y={laneY.dates - 14}
                  height={28}
                >
                  <title>
                    {t(`participant.timeline.phases.${phase.kind}`, {
                      from: formatDate(phase.from),
                      to: formatDate(phase.to),
                    })}
                  </title>
                </rect>
              ))}
              <line className="tp-timeline-axis" x1="2%" x2="98%" y1={axisY} y2={axisY} />
              <text className="tp-timeline-axis-label" x="2%" y={axisY + 16} textAnchor="start">
                {formatDate(from)}
              </text>
              <text className="tp-timeline-axis-label" x="98%" y={axisY + 16} textAnchor="end">
                {formatDate(to)}
              </text>
              <line
                className="tp-timeline-today"
                x1={`${todayAt}%`}
                x2={`${todayAt}%`}
                y1={18}
                y2={axisY}
              />
              <text
                className="tp-timeline-today-label"
                x={`${todayAt}%`}
                y={12}
                textAnchor={todayAt < 8 ? "start" : todayAt > 92 ? "end" : "middle"}
              >
                {t("participant.timeline.today")}
              </text>
              {facts.map((fact, index) => {
                const tone =
                  fact.lane === "deadlines" && fact.state === "overdue"
                    ? " tp-timeline-marker--overdue"
                    : "";
                const shape = (
                  <path
                    className={`tp-timeline-shape tp-timeline-shape--${fact.lane}${tone}`}
                    d={shapes[fact.lane]}
                  />
                );
                const linked = available(fact.target);
                return (
                  <svg
                    key={`${fact.lane}-${fact.kind}-${fact.date}-${index}`}
                    x={`${at(fact.date)}%`}
                    y={laneY[fact.lane] + offsets[index]!}
                    overflow="visible"
                    className="tp-timeline-marker"
                  >
                    {linked ? (
                      <a
                        href={href(fact.target)}
                        aria-label={`${description(fact)} – ${targetName(fact.target)}`}
                        onClick={(event) => {
                          event.preventDefault();
                          onOpen(fact.target);
                        }}
                        onFocus={() => setActive(index)}
                        onBlur={() => setActive(null)}
                        onMouseEnter={() => setActive(index)}
                        onMouseLeave={() => setActive(null)}
                        onKeyDown={(event) => event.key === "Escape" && setActive(null)}
                      >
                        {shape}
                      </a>
                    ) : (
                      <g onMouseEnter={() => setActive(index)} onMouseLeave={() => setActive(null)}>
                        <title>{description(fact)}</title>
                        {shape}
                      </g>
                    )}
                  </svg>
                );
              })}
            </svg>
            {shown && (
              // Hover and focus show the same text as the marker's name; the list holds it too.
              <div
                className="tp-timeline-tooltip"
                aria-hidden="true"
                style={{
                  left: `${at(shown.date)}%`,
                  top: `${laneY[shown.lane] + 14}px`,
                }}
              >
                {description(shown)}
              </div>
            )}
            <Legend />
          </div>
          <h3>{t("participant.timeline.listTitle")}</h3>
          <ol className="tp-timeline-list">
            {facts.map((fact, index) => {
              const { label, state } = text(fact);
              return (
                <li key={`${fact.lane}-${fact.kind}-${fact.date}-${index}`}>
                  <span className="tp-timeline-list-date">{formatDate(fact.date)}</span>{" "}
                  <span>{label}</span>
                  {fact.lane === "deadlines" && fact.state ? (
                    <>
                      {" "}
                      <StatusTag family="deadline" code={fact.state} />
                    </>
                  ) : (
                    state && <span>{` · ${state}`}</span>
                  )}
                  {available(fact.target) && (
                    <>
                      {" · "}
                      <a
                        href={href(fact.target)}
                        onClick={(event) => {
                          event.preventDefault();
                          onOpen(fact.target);
                        }}
                      >
                        {targetName(fact.target)}
                      </a>
                    </>
                  )}
                </li>
              );
            })}
          </ol>
        </>
      )}
    </Card>
  );
}

/** One entry of the legend: the shape and its text. */
function LegendEntry({
  lane,
  label,
  extra = "",
}: {
  lane: TimelineFact["lane"];
  label: string;
  extra?: string;
}) {
  return (
    <li>
      <svg width="18" height="18" aria-hidden="true" className="tp-timeline-legend-shape">
        <svg x="9" y="9" overflow="visible">
          <path
            className={`tp-timeline-shape tp-timeline-shape--${lane}${extra}`}
            d={shapes[lane]}
          />
        </svg>
      </svg>
      {label}
    </li>
  );
}

/** What each shape means, as text beside it (never colour alone, WCAG 1.4.1). */
function Legend() {
  const { t } = useTranslation();
  return (
    <ul className="tp-timeline-legend" aria-label={t("participant.timeline.legend")}>
      <LegendEntry lane="dates" label={t("participant.timeline.lanes.dates")} />
      <LegendEntry lane="deadlines" label={t("participant.timeline.lanes.deadlines")} />
      <LegendEntry
        lane="deadlines"
        label={t("participant.timeline.lanes.overdue")}
        extra=" tp-timeline-marker--overdue"
      />
      <LegendEntry lane="appointments" label={t("participant.timeline.lanes.appointments")} />
    </ul>
  );
}

/** Today in Berlin (the snapshot's day where there is one). */
export function berlinToday(generatedAt: string | undefined): string {
  return berlinDate(generatedAt ?? new Date().toISOString());
}
