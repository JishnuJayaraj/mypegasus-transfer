import { z } from "zod";
import { edges, type Edge } from "./edges";
import type { MainStatus } from "./enums";
import { canTransition, type TransitionContext } from "./transition";

// process-and-lifecycle.md, the manual contact statuses (Q215): staff move `imported → contacted`
// and `contacted ↔ unreachable` along the existing `manual` edges with their guards
// (`unreachable → contacted` keeps `before_cutoff`); who may is Q60's `mayPerformTransition`.

/** The targets of "Kontaktstatus": the two contact statuses. */
export const ContactStatusTarget = z
  .enum(["contacted", "unreachable"])
  .meta({ id: "ContactStatusTarget" });
export type ContactStatusTarget = z.infer<typeof ContactStatusTarget>;

const contactSources: ReadonlySet<MainStatus> = new Set(["imported", "contacted", "unreachable"]);
const targets: ReadonlySet<string> = new Set(ContactStatusTarget.options);

/** The manual contact edges of the main track (`informed` is the attendance's, never this). */
export const contactEdges: readonly Edge[] = edges.filter(
  (e) =>
    e.track === "main" &&
    e.actor === "user" &&
    e.kind === "manual" &&
    e.from !== null &&
    contactSources.has(e.from as MainStatus) &&
    targets.has(e.to),
);

/** Why a contact step is closed now: no permission, the project, else its guard. */
export const ContactStatusRefusal = z
  .enum(["forbidden", "project_not_active", "before_cutoff"])
  .meta({ id: "ContactStatusRefusal" });
export type ContactStatusRefusal = z.infer<typeof ContactStatusRefusal>;

/** An authorised contact step closed now, with its reason (ui-patterns.md, C1; Q233). */
export const BlockedContactStep = z
  .strictObject({
    to: ContactStatusTarget,
    refusal: z.enum(["project_not_active", "before_cutoff"]),
  })
  .meta({ id: "BlockedContactStep" });
export type BlockedContactStep = z.infer<typeof BlockedContactStep>;

/** The steps the viewer may take but which are closed now: never the forbidden ones. */
export const blockedContactSteps = (steps: readonly ContactTransition[]): BlockedContactStep[] =>
  steps.flatMap((s) =>
    s.refusal === "project_not_active" || s.refusal === "before_cutoff"
      ? [{ to: s.to, refusal: s.refusal }]
      : [],
  );

export type ContactTransition = {
  to: ContactStatusTarget;
  allowed: boolean;
  refusal: ContactStatusRefusal | null;
};

/**
 * The contact steps from the current main status, each allowed or closed with the first reason:
 * the viewer's permission (`permits`), the project's draft gate, then the lifecycle check with the
 * dated facts. No edge from the status (e.g. `informed`, a terminal status) is no step.
 */
export function contactTransitions(
  context: TransitionContext,
  permits: (edge: Edge) => boolean,
  projectActive: boolean,
): ContactTransition[] {
  const from = context.current.status;
  return contactEdges
    .filter((edge) => edge.from === from)
    .map((edge): ContactTransition => {
      const to = edge.to as ContactStatusTarget;
      if (!permits(edge)) return { to, allowed: false, refusal: "forbidden" };
      if (!projectActive) return { to, allowed: false, refusal: "project_not_active" };
      const check = canTransition("main", from, to, context);
      // The contact edges carry no guard but `before_cutoff` (the lifecycle transitions table).
      return check.ok
        ? { to, allowed: true, refusal: null }
        : { to, allowed: false, refusal: "before_cutoff" };
    });
}

/** Whether the viewer may take some contact step at all (the route's 403, before any state). */
export const mayTakeSomeContactStep = (permits: (edge: Edge) => boolean) =>
  contactEdges.some(permits);

/** `POST /participations/{id}/contact-status`: the target and the status version read. */
export const ContactStatusRequest = z
  .strictObject({ to: ContactStatusTarget, statusVersion: z.int().min(0) })
  .meta({ id: "ContactStatusRequest" });
export type ContactStatusRequest = z.infer<typeof ContactStatusRequest>;
