import { resolveForProject } from "@transfer/config";
import { eq, project, projectEntryWave, sql, type Database } from "@transfer/db";
import { projectActivationBlockers, type ProjectActivation } from "@transfer/domain";
import { functionRefusal } from "../database-errors";
import { auditContext, callFunction, utc } from "../sql";
import { projectSnapshot, submissionBlockers, type Release } from "./template-pins";

/** The activation refusals that are a 422 (R21); `project_not_found` is a 404. */
const activationRefusals: ReadonlySet<string> = new Set([
  "project_not_draft",
  "project_activation_blocked",
  "no_entry_wave_with_latest_entry_date",
]);

/**
 * Activates a draft project (plan 5.5, Q98), in one transaction under the exclusive project lock:
 * the project's state first (`project_not_draft`, R1: one-way), then the project level resolved
 * from the snapshot with the current override (R11) and the waves (`projectActivationBlockers`,
 * Q76, Q77, Q90); any blocker refuses with its code, else `activate_project` re-checks and
 * writes. The Agentur-submission blockers never block (Q91, Q92) and come back as warnings with
 * their Agentur and step (round 15 reading 10). Returns null for no project, or the refusals.
 */
export async function activateProject(
  db: Database,
  release: Release,
  actor: { staffUserId: string; requestId: string | null },
  projectId: string,
): Promise<ProjectActivation | { issues: readonly string[] } | null> {
  return db
    .transaction(async (tx) => {
      // The function takes the lock again (re-entrant).
      await tx.execute(sql`select lock_project_setup(${projectId}::uuid)`);
      const { project: found, pins, input } = (await projectSnapshot(tx, release, projectId))!;
      if (found.status !== "draft") return { issues: ["project_not_draft"] };
      const waves = await tx
        .select({ latestEntryDate: projectEntryWave.latestEntryDate })
        .from(projectEntryWave)
        .where(eq(projectEntryWave.projectId, projectId));
      const blockers = projectActivationBlockers(found, waves, resolveForProject(input));
      if (blockers.length) return { issues: blockers };
      await callFunction(
        tx,
        sql`activate_project(p_id => ${projectId}::uuid,
          p_base_defaults_version => ${release.baseDefaults.version}::integer,
          p_context => ${auditContext(actor.staffUserId, actor.requestId)})`,
      );
      const [activated] = await tx
        .select({ activatedAt: utc(project.activatedAt) })
        .from(project)
        .where(eq(project.id, projectId));
      return {
        status: "active" as const,
        activatedAt: activated!.activatedAt,
        warnings: submissionBlockers(input, pins).flatMap(({ warnings }) => warnings),
      };
    })
    .catch((error: unknown) => {
      const code = functionRefusal(error);
      if (code === "project_not_found") return null;
      if (code !== undefined && activationRefusals.has(code)) return { issues: [code] };
      throw error;
    });
}
