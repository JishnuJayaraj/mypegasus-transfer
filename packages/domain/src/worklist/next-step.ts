import { berlinDate, type AppointmentKind } from "../appointments/model";
import type { IsoDate } from "../iso-date";
import { LifecycleFlag } from "../lifecycle/enums";
import { AgenturItemKind } from "../profiling/submissions";
import type { ParticipantAction } from "./actions";
import { AppointmentItemKind } from "./appointments";
import { DeadlineKind } from "./deadlines";
import { WorklistCaseItem, type WorklistItem } from "./projection";

// "Nächster Schritt" (process-and-lifecycle.md, the work list's next step and default order):
// one row's open items in one order, read from what the row already carries. It changes nothing.

/**
 * 1 overdue (deadlines, appointment items), 2 undated or escalated work (case items, Agentur
 * items, lifecycle flags), 3 upcoming deadlines, 4 the participant's actions.
 */
export type NextStepTier = 1 | 2 | 3 | 4;

export type OpenStep = { tier: NextStepTier } & (
  | { source: "deadline"; kind: DeadlineKind; date: IsoDate; final?: boolean }
  | {
      source: "appointment";
      kind: AppointmentItemKind;
      appointmentKind: AppointmentKind;
      date: IsoDate;
    }
  | { source: "case"; kind: WorklistCaseItem["kind"]; date: IsoDate }
  | { source: "agentur"; kind: AgenturItemKind; date: IsoDate }
  | { source: "flag"; kind: LifecycleFlag }
  | { source: "action"; kind: ParticipantAction["kind"]; action: ParticipantAction }
);

/** Within a tier the sources keep this order on a tie (the kind order across sources). */
const sources = ["deadline", "appointment", "case", "agentur", "flag", "action"] as const;
const kindOrders: Record<Exclude<OpenStep["source"], "action">, readonly string[]> = {
  deadline: DeadlineKind.options,
  appointment: AppointmentItemKind.options,
  case: WorklistCaseItem.shape.kind.options,
  agentur: AgenturItemKind.options,
  flag: LifecycleFlag.options,
};

/** The date a step is ordered by; `knowledge_date_missing`'s is an orientation, never a date. */
function orderDate(step: OpenStep): IsoDate | null {
  if (!("date" in step) || step.kind === "knowledge_date_missing") return null;
  return step.date;
}

/** The kind order: the source, then the kind; an action keeps its place in the row's list. */
function kindRank(step: OpenStep, index: number): number {
  const source = sources.indexOf(step.source) * 1000;
  if (step.source === "action") {
    // Rejected uploads first, then missing documents, then missing fields.
    const group = step.action.state === "rejected" ? 0 : step.action.kind === "document" ? 1 : 2;
    return source + group * 100 + index;
  }
  return source + kindOrders[step.source].indexOf(step.kind);
}

type Ranked = { step: OpenStep; rank: number };

function compareRanked(a: Ranked, b: Ranked): number {
  const [x, y] = [orderDate(a.step), orderDate(b.step)];
  const date = x === y ? 0 : x === null ? 1 : y === null ? -1 : x.localeCompare(y);
  return a.step.tier - b.step.tier || date || a.rank - b.rank;
}

/** Every open item of the row, the next step first. */
export function openSteps(item: WorklistItem): OpenStep[] {
  const steps: OpenStep[] = [
    ...item.deadlines.map(({ kind, date, state, final }): OpenStep => ({
      tier: state === "overdue" ? 1 : 3,
      source: "deadline",
      kind,
      date,
      ...(final !== undefined && { final }),
    })),
    // Overdue appointments and those to resolve alike: neither waits for a date.
    ...item.appointments.items.map((a): OpenStep => ({
      tier: 1,
      source: "appointment",
      kind: a.kind,
      appointmentKind: a.appointmentKind,
      date: berlinDate(a.startsAt),
    })),
    ...item.caseItems.map(({ kind, date }): OpenStep => ({ tier: 2, source: "case", kind, date })),
    ...item.agenturItems.map(({ kind, date }): OpenStep => ({
      tier: 2,
      source: "agentur",
      kind,
      date,
    })),
    ...item.flags.map((kind): OpenStep => ({ tier: 2, source: "flag", kind })),
    ...item.actions.map((action): OpenStep => ({
      tier: 4,
      source: "action",
      kind: action.kind,
      action,
    })),
  ];
  return steps
    .map((step, index): Ranked => ({ step, rank: kindRank(step, index) }))
    .toSorted(compareRanked)
    .map(({ step }) => step);
}

/** The row's next step and how many other items are open; null when nothing is ("–"). */
export function nextStep(item: WorklistItem): { step: OpenStep; more: number } | null {
  const [step, ...rest] = openSteps(item);
  return step ? { step, more: rest.length } : null;
}

/** Two rows' next steps: the more urgent first, no step last. */
export function compareOpenSteps(a: OpenStep | null, b: OpenStep | null): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  return compareRanked({ step: a, rank: kindRank(a, 0) }, { step: b, rank: kindRank(b, 0) });
}

const collator = new Intl.Collator("de", { sensitivity: "base" });

/**
 * The work list's default order (process-and-lifecycle.md, the work list's next step and default
 * order): by the rows' next steps, then the most open items, then the last name in German order
 * (none last), else the snapshot's order. A new array; the input stays.
 */
export function urgencyOrder(items: readonly WorklistItem[]): WorklistItem[] {
  const keyed = items.map((item) => {
    const steps = openSteps(item);
    return { item, next: steps[0] ?? null, open: steps.length };
  });
  return keyed
    .toSorted(
      (a, b) =>
        compareOpenSteps(a.next, b.next) ||
        b.open - a.open ||
        compareNames(a.item.lastName, b.item.lastName),
    )
    .map(({ item }) => item);
}

const missing = (name: string | undefined) => (name === undefined ? 1 : 0);

function compareNames(a: string | undefined, b: string | undefined): number {
  return missing(a) - missing(b) || collator.compare(a ?? "", b ?? "");
}
