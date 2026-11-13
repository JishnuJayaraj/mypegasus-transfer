import type { components } from "@transfer/api-client";
import { nextStep, type OpenStep } from "@transfer/domain";
import { stepTarget, type ParticipantTab, type StepTarget } from "./open-steps";
import { activationPanels } from "./participant-activation";

// The participant page's one primary action (ui-patterns.md, principle 3 and C2): the next step
// of the participation (`nextStep`, process-and-lifecycle.md, the work list's next step and
// default order) where the viewer may take it. It reads what the page already has: the work
// list's row and the detail's capabilities. Only the fixed lifecycle core decides (ADR-0004).

type Detail = components["schemas"]["ParticipationDetail"];
type Item = components["schemas"]["WorklistItem"];

/** Who looks at the page: the detail with its capabilities, and the tabs the page shows them. */
export interface StepViewer {
  detail: Detail;
  taTg: boolean;
  hasTab: (tab: ParticipantTab) => boolean;
}

/** Whether the page shows the viewer the tab or card an item is resolved in. */
export function placeShown(target: StepTarget, { detail, taTg, hasTab }: StepViewer): boolean {
  if ("tab" in target) return hasTab(target.tab);
  switch (target.anchor) {
    case "participant-dates":
      return taTg;
    case "participant-ba":
      return taTg && detail.baReportingTasks !== undefined;
    default:
      return true;
  }
}

/**
 * Whether the viewer may take the step where it is resolved: a tab they have, or a card of the
 * overview whose action their capabilities allow now. A blocked card action is no primary
 * action; its prerequisite stays beside the item (C1).
 */
function mayTake(step: OpenStep, target: StepTarget, viewer: StepViewer): boolean {
  if (!placeShown(target, viewer)) return false;
  if ("tab" in target) return true;
  const { detail } = viewer;
  switch (target.anchor) {
    case "participant-dates":
      return step.source === "flag" && step.kind === "informed_without_wave_at_cutoff"
        ? detail.capabilities.assignEntryWave
        : detail.capabilities.setParticipationDates;
    case "participant-activation":
      return activationPanels(detail).includes("notice");
    case "participant-ba":
      return (detail.baReportingTasks ?? []).some((task) => task.capabilities.recordOutcome);
    case "participant-stand":
      return false;
  }
}

/** The next step and its place when the viewer may take it there; else null (no primary action). */
export function primaryStep(
  item: Item | undefined,
  viewer: StepViewer,
): { step: OpenStep; target: StepTarget } | null {
  const next = item ? nextStep(item) : null;
  if (!next) return null;
  const target = stepTarget(next.step);
  return mayTake(next.step, target, viewer) ? { step: next.step, target } : null;
}
