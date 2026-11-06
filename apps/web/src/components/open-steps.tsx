import type { components } from "@transfer/api-client";
import type { OpenStep } from "@transfer/domain";
import { formatDate, RelativeDate } from "@transfer/ui";
import { useTranslation } from "react-i18next";
import { useSelfServiceLabel } from "./self-service-tab";

// One open item of a participation (process-and-lifecycle.md, the work list's next step and
// default order) as the work list's "Nächster Schritt" and the participant overview's "Offen"
// name it, and where on the participant page it is resolved.

type CaseItemKind = Exclude<
  components["schemas"]["WorklistItem"]["caseItems"][number]["kind"],
  "knowledge_date_missing"
>;

/** One open item's label; tiers 1 and 3 with their relative and absolute date. */
export function StepLabel({ step, today }: { step: OpenStep; today: string }) {
  const { t } = useTranslation();
  const label = useSelfServiceLabel();
  switch (step.source) {
    case "deadline":
      // The kind, then relative and absolute date (ui-patterns.md, principle 5).
      return (
        <>
          {`${t(`worklist.deadlineKinds.${step.kind}`)}: `}
          <RelativeDate date={step.date} today={today} kind="deadline" />
          {step.final && ` (${t("worklist.deadlineFinal")})`}
        </>
      );
    case "appointment":
      return (
        <>
          {`${t(`worklist.appointmentItems.${step.kind}`)}: ${t(`appointments.kinds.${step.appointmentKind}`)}, `}
          <RelativeDate date={step.date} today={today} kind="event" />
        </>
      );
    case "case":
      // Without a dated deadline the ASU orientation, never as overdue (process-and-lifecycle.md, dates).
      return step.kind === "knowledge_date_missing"
        ? t("worklist.knowledgeDateMissing", { date: formatDate(step.date) })
        : t(`worklist.caseItems.${step.kind as CaseItemKind}`, { date: formatDate(step.date) });
    case "agentur":
      return t(`worklist.agenturItems.${step.kind}`, { date: formatDate(step.date) });
    case "flag":
      return t(`worklist.flags.${step.kind}`);
    case "action":
      return `${label(step.action.key)} ${t(`worklist.actionStates.${step.action.state}`)}`;
  }
}

/** A tab of the participant page that resolves an item. */
export type ParticipantTab = "self-service" | "profiling" | "asu" | "documents" | "appointments";

/** The overview's cards an item can point to (their `Card id`). */
export type OverviewAnchor =
  | "participant-stand"
  | "participant-dates"
  | "participant-activation"
  | "participant-ba";

/**
 * Where an open item is resolved: a tab, or a card of the overview. Only the fixed lifecycle core
 * decides this (ADR-0004); nothing regional.
 */
export type StepTarget = { tab: ParticipantTab } | { anchor: OverviewAnchor };

/** The wave and contractual dates resolve these (process-and-lifecycle.md, Dates; DSV track). */
const datesFlags: ReadonlySet<string> = new Set([
  "tg_start_missed",
  "cutoff_warning",
  "cutoff_final_reminder",
  "dsv_never_offered",
  "informed_without_wave_at_cutoff",
]);

export function stepTarget(step: OpenStep): StepTarget {
  switch (step.source) {
    case "deadline":
      switch (step.kind) {
        case "asu_due":
          return { tab: "asu" };
        case "tl407_submission":
        case "profiling_exception":
          return { tab: "profiling" };
        case "privacy_notice":
          return { anchor: "participant-activation" };
        case "offer_deadline":
        case "tg_start":
        case "latest_entry_cutoff":
          return { anchor: "participant-dates" };
      }
      break;
    case "appointment":
      return { tab: "appointments" };
    case "case":
      // The ASU record holds the knowledge date and the Kug 200b offer (asu-tab.tsx); an
      // invalidated evidence document is replaced among the documents.
      return step.kind === "evidence_invalidated" ? { tab: "documents" } : { tab: "asu" };
    case "agentur":
      return step.kind === "ba_report_pending"
        ? { anchor: "participant-ba" }
        : step.kind === "kug200b_confirmation_missing"
          ? { tab: "asu" }
          : { tab: "profiling" };
    case "flag":
      return datesFlags.has(step.kind) ? { anchor: "participant-dates" } : { tab: "profiling" };
    case "action":
      return step.action.kind === "document" ? { tab: "documents" } : { tab: "self-service" };
  }
}
