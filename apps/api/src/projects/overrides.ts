import { validateProjectOverride, withAgenturSetting } from "@transfer/config";
import { eq, project, sql, type Database } from "@transfer/db";
import type { OverrideChange, TemporaryAgenturSetting } from "@transfer/domain";
import { functionRefusal } from "../database-errors";
import { auditContext, callFunction } from "../sql";
import {
  currentOverride,
  currentPins,
  overrideIssues,
  templatesOf,
  type Release,
} from "./template-pins";

export type OverrideOutcome =
  | { ok: true }
  | { problem: "not-found" | "conflict" }
  | { issues: readonly string[] };

/**
 * Sets (`setting`) or removes (`null`) an Agentur's scoped setting (plan 5.9, round 8, Q93) as a
 * new override version, in one transaction under the exclusive project lock: compares the
 * expected version (409 when stale), builds the new content, validates it against the base-only
 * chain and every pinned chain (`validateProjectOverride`, R16), then `write_project_override`.
 * The setting's rules (R14) are the route's, with the injected `Clock`.
 */
export async function changeAgenturSetting(
  db: Database,
  release: Release,
  actor: { staffUserId: string; requestId: string | null },
  projectId: string,
  agenturKey: string,
  change: { expectedVersion: number; setting: TemporaryAgenturSetting | null },
): Promise<OverrideOutcome> {
  return db
    .transaction(async (tx): Promise<OverrideOutcome> => {
      // The function takes the lock again (re-entrant).
      await tx.execute(sql`select lock_project_setup(${projectId}::uuid)`);
      const [found] = await tx
        .select({ type: project.type })
        .from(project)
        .where(eq(project.id, projectId));
      const current = await currentOverride(tx, projectId);
      if (current.version !== change.expectedVersion) return { problem: "conflict" };
      const scoped = current.content?.agenturSettings ?? {};
      if (!change.setting && !Object.hasOwn(scoped, agenturKey)) return { problem: "not-found" };
      const content = withAgenturSetting(current.content, agenturKey, change.setting);
      const validation = validateProjectOverride({
        base: release.baseDefaults,
        templatesByAgentur: templatesOf(await currentPins(tx, projectId)),
        override: content,
        projectType: found!.type,
      });
      if (!validation.ok) return { issues: overrideIssues(validation) };
      const kind: OverrideChange = change.setting
        ? "agentur_setting_set"
        : "agentur_setting_removed";
      await callFunction(
        tx,
        sql`write_project_override(p_project_id => ${projectId}::uuid,
          p_expected_version => ${change.expectedVersion}::integer,
          p_content => ${JSON.stringify(content)}::jsonb, p_change => ${kind},
          p_agentur_key => ${agenturKey},
          p_base_defaults_version => ${release.baseDefaults.version}::integer,
          p_context => ${auditContext(actor.staffUserId, actor.requestId)})`,
      );
      return { ok: true };
    })
    .catch((error: unknown): OverrideOutcome => {
      // Mapped per R21; anything else is a 500.
      const code = functionRefusal(error);
      if (code === "project_not_found") return { problem: "not-found" };
      if (code === "override_version_stale") return { problem: "conflict" };
      if (code === "override_unchanged") return { issues: [code] };
      throw error;
    });
}
