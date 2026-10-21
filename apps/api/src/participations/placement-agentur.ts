import { validateProjectOverride } from "@transfer/config";
import { eq, participation, project, sql, type Database } from "@transfer/db";
import { planPlacementAgentur } from "@transfer/domain";
import { functionRefusal } from "../database-errors";
import {
  currentOverride,
  currentPins,
  overrideIssues,
  releaseTemplate,
  templatesOf,
  type Release,
} from "../projects/template-pins";
import { auditContext, callFunction } from "../sql";

/** The refusals of `set_placement_agentur` that are a 422; `participation_not_found` is a 404. */
const refusals: ReadonlySet<string> = new Set([
  "participation_closed",
  "placement_agentur_unchanged",
  "template_already_pinned",
  "template_version_changed",
]);

/**
 * Sets a participation's placement Agentur (Q139; regional-variation.md, "Placement Agentur"), in
 * one transaction under the exclusive project lock: decides with `planPlacementAgentur` on the
 * state read under the lock; a catalog Agentur the project hasn't pinned is pinned at its latest
 * version, read through `loadTemplate` with its canonical hash, unless the current override would
 * no longer validate with it (`override_invalid` and its issues; nothing is written). The caller
 * checked the permission; the function checks it again (`forbidden` when a membership ended
 * meanwhile). Returns null for no participation, or the refusals.
 */
export async function setPlacementAgentur(
  db: Database,
  release: Release,
  actor: { staffUserId: string; requestId: string | null },
  participationId: string,
  agenturKey: string,
): Promise<true | "forbidden" | { issues: readonly string[] } | null> {
  const context = auditContext(actor.staffUserId, actor.requestId);
  return db
    .transaction(async (tx) => {
      const [found] = await tx
        .select({ projectId: participation.projectId })
        .from(participation)
        .where(eq(participation.id, participationId));
      if (!found) return null;
      const { projectId } = found;
      // The function takes the lock again (re-entrant).
      await tx.execute(sql`select lock_project_setup(${projectId}::uuid)`);
      const [state] = await tx
        .select({
          status: participation.status,
          placementAgenturKey: participation.placementAgenturKey,
          projectType: project.type,
        })
        .from(participation)
        .innerJoin(project, eq(project.id, participation.projectId))
        .where(eq(participation.id, participationId));
      const pins = await currentPins(tx, projectId);
      const plan = planPlacementAgentur({
        participation: state!,
        catalog: release.catalog,
        pins,
        agenturKey,
      });
      if (!plan.ok) return { issues: [plan.code] };
      let pin = sql``;
      if (plan.pinVersion !== null) {
        const { template, sha256 } = releaseTemplate(release, agenturKey, plan.pinVersion);
        // A further pinned Agentur keeps the override valid across every chain, as a plain pin.
        const { content } = await currentOverride(tx, projectId);
        const validation = validateProjectOverride({
          base: release.baseDefaults,
          templatesByAgentur: { ...templatesOf(pins), [agenturKey]: template },
          override: content ?? { schemaVersion: 1, kind: "project_override" },
          projectType: state!.projectType,
        });
        if (!validation.ok) return { issues: overrideIssues(validation) };
        pin = sql`, p_pin_version => ${plan.pinVersion}::integer,
          p_pin_content => ${JSON.stringify(template)}::jsonb, p_pin_sha256 => ${sha256}`;
      }
      await callFunction(
        tx,
        sql`set_placement_agentur(p_participation_id => ${participationId}::uuid,
          p_agentur_key => ${agenturKey},
          p_base_defaults_version => ${release.baseDefaults.version}::integer,
          p_context => ${context}${pin})`,
      );
      return true as const;
    })
    .catch((error: unknown) => {
      const code = functionRefusal(error);
      if (code === "participation_not_found") return null;
      if (code === "actor_not_allowed") return "forbidden" as const;
      if (code !== undefined && refusals.has(code)) return { issues: [code] };
      throw error;
    });
}
