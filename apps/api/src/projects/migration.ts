import { migrationPreview, validateProjectOverride, withReviewedSetting } from "@transfer/config";
import { sql, type Database } from "@transfer/db";
import {
  checkMigrationDecisions,
  planTemplateMigration,
  settingKeys,
  type MigrateTemplateInput,
  type MigrationPreviewInput,
  type TemplateMigrationPreview,
} from "@transfer/domain";
import { callFunction } from "../sql";
import {
  contextOf,
  issue,
  underLock,
  type OverrideOutcome,
  type Refusals,
  type Writer,
} from "./overrides";
import { overrideIssues, projectSnapshot, releaseTemplate, type Release } from "./template-pins";

type Snapshot = NonNullable<Awaited<ReturnType<typeof projectSnapshot>>>;

// The function refusals a migration allowlists (R21, round 23); anything else is a 500.
const migrationRefusals: Refusals<"not-found" | "conflict"> = {
  project_not_found: { problem: "not-found" },
  agentur_not_pinned: { problem: "not-found" },
  pin_version_stale: { problem: "conflict" },
  override_version_stale: { problem: "conflict" },
  template_already_pinned: issue("template_already_pinned"),
  template_version_not_newer: issue("template_version_not_newer"),
  template_version_changed: issue("template_version_changed"),
};

/**
 * The migration of `agenturKey`'s pin to `version` planned on a snapshot (plan 5.8; round 31's
 * order): null when the Agentur isn't pinned (a 404), the refusal of the target at `/version`,
 * `stale` when the pin moved away from a confirm's `fromVersion`, or the version the migration
 * starts from with the release's target template.
 */
function planMigrationTarget(
  release: Release,
  snapshot: Snapshot,
  agenturKey: string,
  target: { version: number; fromVersion?: number },
) {
  const pin = snapshot.pins.find((p) => p.agenturKey === agenturKey);
  const planned = planTemplateMigration({ catalog: release.catalog, pin, ...target });
  if (planned === null || !("fromVersion" in planned)) return planned;
  return { ...planned, ...releaseTemplate(release, agenturKey, target.version) };
}

/**
 * What migrating the pin would change, with the review of the Agentur's scoped setting (5.8,
 * AC-19; R15): read-only, on one coherent snapshot (a read-only `REPEATABLE READ` transaction,
 * round 31), so its pins and override are never from both sides of a concurrent migration. Null
 * for no project or no pin of the Agentur (404), the refusal of the target (422), or the preview
 * with the versions a confirm sends back.
 */
export function previewMigration(
  db: Database,
  release: Release,
  projectId: string,
  agenturKey: string,
  input: MigrationPreviewInput,
): Promise<
  TemplateMigrationPreview | { issues: readonly { code: string; field: string }[] } | null
> {
  return db.transaction(
    async (tx) => {
      const snapshot = await projectSnapshot(tx, release, projectId);
      const planned =
        snapshot && planMigrationTarget(release, snapshot, agenturKey, { version: input.version });
      if (!planned) return null;
      if ("issues" in planned) return planned;
      // Without a declared `fromVersion` the pin can't be stale.
      if (!("fromVersion" in planned)) return null;
      return {
        agenturKey,
        fromVersion: planned.fromVersion,
        version: input.version,
        expectedVersion: snapshot.override.version,
        ...migrationPreview({ ...snapshot.input, agenturKey, target: planned.template }),
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

/**
 * The confirmed migration (5.8, AC-20; R15), in one transaction under the exclusive project lock:
 * reloads the snapshot and re-plans in round 31's order: 404 without the pin, 422 for a target
 * absent from the catalog or not newer than the declared `fromVersion`, 409 when the pin moved
 * away from it (to the target or beyond) or the override from `expectedVersion`; then keep or remove for
 * exactly the review's keys (`review_incomplete`), validates the override that results against
 * every chain with the new version (`override_invalid`, AC-16), then `migrate_agentur_template`
 * writes the pin and, when keys are removed, the override version with their audit events and
 * the base-defaults version (R26).
 */
export function migrateTemplate(
  writer: Writer,
  projectId: string,
  agenturKey: string,
  input: MigrateTemplateInput,
): Promise<OverrideOutcome> {
  const { release } = writer;
  return underLock<"not-found" | "conflict">(
    writer.db,
    projectId,
    migrationRefusals,
    async (tx) => {
      const snapshot = (await projectSnapshot(tx, release, projectId))!;
      const planned = planMigrationTarget(release, snapshot, agenturKey, input);
      if (!planned) return { problem: "not-found" };
      if ("issues" in planned) return planned;
      const { override, input: chain } = snapshot;
      if ("stale" in planned || override.version !== input.expectedVersion) {
        return { problem: "conflict" };
      }
      const scoped = override.content?.agenturSettings?.[agenturKey]?.settings ?? {};
      const review = checkMigrationDecisions(settingKeys(scoped), input.decisions);
      if (review.length) return { issues: review };
      const next = withReviewedSetting(override.content, agenturKey, input.decisions);
      const validation = validateProjectOverride({
        base: release.baseDefaults,
        templatesByAgentur: { ...chain.templatesByAgentur, [agenturKey]: planned.template },
        override: next ?? override.content ?? { schemaVersion: 1, kind: "project_override" },
        projectType: chain.projectType,
      });
      if (!validation.ok) return { issues: overrideIssues(validation) };
      await callFunction(
        tx,
        sql`migrate_agentur_template(p_project_id => ${projectId}::uuid,
        p_agentur_key => ${agenturKey}, p_from_version => ${input.fromVersion}::integer,
        p_version => ${input.version}::integer,
        p_content => ${JSON.stringify(planned.template)}::jsonb, p_sha256 => ${planned.sha256},
        p_expected_version => ${input.expectedVersion}::integer,
        p_override_content => ${next && JSON.stringify(next)}::jsonb,
        p_base_defaults_version => ${release.baseDefaults.version}::integer,
        p_context => ${contextOf(writer)})`,
      );
      return { ok: true };
    },
  );
}
