import type { ProjectPermissions } from "../access";
import {
  parseLayer,
  relaxableRules,
  resolveForParticipation,
  resolveForProject,
  validateProjectOverride,
  type BaseDefaults,
  type Blocker,
  type OverrideValidation,
  type ProjectOverride,
  type RegionalTemplate,
  type TemplateManifestEntry,
} from "@transfer/config";
import {
  canonicalHash,
  configDirs,
  loadBaseDefaults,
  loadManifest,
  loadTemplate,
} from "@transfer/config/load";
import {
  and,
  asc,
  configRelaxationRequest as relaxationRequest,
  configTemplateVersion as templateVersion,
  desc,
  eq,
  project,
  projectConfigOverride,
  projectEntryWave,
  projectTemplatePin as pin,
  sql,
  type Database,
} from "@transfer/db";
import {
  ApprovedRelaxation,
  migrationTargets,
  planTemplatePin,
  projectActivationBlockers,
  type PinIssue,
  type PinTemplateInput,
  type ProjectConfig,
} from "@transfer/domain";
import { functionRefusal } from "../database-errors";
import { auditContext, callFunction, utc } from "../sql";

/**
 * The configuration of this release (S2): the catalog, the template files and the base defaults,
 * read once at start from `CONFIG_DIR`. Base defaults are not pinned (Q107); templates are, so a
 * project resolves only from its stored snapshot.
 */
export type Release = {
  templatesDir: URL;
  catalog: readonly TemplateManifestEntry[];
  baseDefaults: BaseDefaults;
};

export function loadRelease(configDir: string | undefined): Release {
  const dirs = configDirs(configDir);
  return {
    templatesDir: dirs.templates,
    catalog: loadManifest(dirs.templates).templates,
    baseDefaults: loadBaseDefaults(dirs.baseDefaults),
  };
}

type Db = Pick<Database, "select" | "selectDistinctOn" | "execute">;

/** The project's current pin per Agentur (the highest `seq`), with the stored snapshot. */
export const currentPins = (db: Db, projectId: string) =>
  db
    .selectDistinctOn([pin.agenturKey], {
      agenturKey: pin.agenturKey,
      version: pin.version,
      pinnedAt: utc(pin.pinnedAt),
      pinnedBy: pin.pinnedBy,
      content: templateVersion.content,
      sha256: templateVersion.contentSha256,
    })
    .from(pin)
    .innerJoin(
      templateVersion,
      and(eq(templateVersion.agenturKey, pin.agenturKey), eq(templateVersion.version, pin.version)),
    )
    .where(eq(pin.projectId, projectId))
    .orderBy(pin.agenturKey, desc(pin.seq));

type StoredPin = Awaited<ReturnType<typeof currentPins>>[number];

// A stored version never changes (regional-variation.md, immutability), so its validated snapshot
// is cached by its identity.
const snapshots = new Map<string, RegionalTemplate>();

/**
 * The stored content of a pin as a template (regional-variation.md, snapshot): validated once,
 * checked against its hash and its key, then cached per (key, version, hash). The template file is
 * never read here.
 */
export function snapshotOf({ agenturKey, version, content, sha256 }: StoredPin): RegionalTemplate {
  const identity = `${agenturKey}@${version}:${sha256}`;
  const cached = snapshots.get(identity);
  if (cached) return cached;
  const result = parseLayer(content);
  const layer = result.ok ? result.layer : undefined;
  if (
    layer?.kind !== "regional_template" ||
    layer.agenturKey !== agenturKey ||
    layer.version !== version ||
    canonicalHash(content) !== sha256
  ) {
    throw new Error(`The stored template ${identity} is not a valid snapshot`);
  }
  snapshots.set(identity, layer);
  return layer;
}

/** The pinned templates by Agentur key, from their snapshots. */
export const templatesOf = (pins: readonly StoredPin[]) =>
  Object.fromEntries(pins.map((p) => [p.agenturKey, snapshotOf(p)]));

/**
 * The project's current override (regional-variation.md, Agentur-scoped settings): the highest
 * version and its stored content, validated as an override layer (a stored row that isn't one is a
 * 500); version 0 without a row.
 */
export async function currentOverride(
  db: Db,
  projectId: string,
): Promise<{ version: number; content: ProjectOverride | undefined }> {
  const [row] = await db
    .select({ version: projectConfigOverride.version, content: projectConfigOverride.content })
    .from(projectConfigOverride)
    .where(eq(projectConfigOverride.projectId, projectId))
    .orderBy(desc(projectConfigOverride.version))
    .limit(1);
  if (!row) return { version: 0, content: undefined };
  const result = parseLayer(row.content);
  if (!result.ok || result.layer.kind !== "project_override") {
    throw new Error(`The stored override version ${row.version} is not an override`);
  }
  return { version: row.version, content: result.layer };
}

/**
 * The project's snapshot as read in `db` (regional-variation.md, snapshot): its type, status and
 * Project Agentur, its current pins and override version, and the resolution input they make.
 * Undefined for no project.
 */
export async function projectSnapshot(db: Db, release: Release, projectId: string) {
  const [found] = await db
    .select({
      type: project.type,
      status: project.status,
      projectAgenturKey: project.projectAgenturKey,
    })
    .from(project)
    .where(eq(project.id, projectId));
  if (!found) return undefined;
  const pins = await currentPins(db, projectId);
  const override = await currentOverride(db, projectId);
  const input = {
    base: release.baseDefaults,
    templatesByAgentur: templatesOf(pins),
    override: override.content,
    projectType: found.type,
    projectAgenturKey: found.projectAgenturKey,
  };
  return { project: found, pins, override, input };
}

/**
 * A template version of this release (regional-variation.md, "Template versions"): the file
 * through `loadTemplate` and its canonical hash, which must be the catalog's; a differing file is
 * a broken image (500).
 */
export function releaseTemplate(release: Release, agenturKey: string, version: number) {
  const template = loadTemplate(agenturKey, version, release.templatesDir);
  const sha256 = canonicalHash(template);
  const entry = release.catalog.find((t) => t.agenturKey === agenturKey && t.version === version);
  if (entry?.sha256 !== sha256) throw new Error("template file differs from the manifest");
  return { template, sha256 };
}

/** A refused override as domain issues (ADR-0010): `override_invalid`, then each issue's code. */
export const overrideIssues = (validation: Extract<OverrideValidation, { ok: false }>) => [
  "override_invalid",
  ...validation.issues.map((issue) => issue.code),
];

const participantLevel = (blockers: Blocker[]) =>
  blockers.filter((blocker) => blocker.code === "agentur_submission_blocked");

/**
 * One participation's participant-level, step-scoped submission blockers (Q76, Q91, Q92), resolved
 * with its placement Agentur (Q139): without a pinned template for it, base and override only.
 */
export const participationSubmissionBlockers = (
  input: Omit<Parameters<typeof resolveForParticipation>[0], "placementAgenturKey">,
  placementAgenturKey: string | null,
) => participantLevel(resolveForParticipation({ ...input, placementAgenturKey }).blockers);

/**
 * Per pinned Agentur as the placement Agentur, its participant-level, step-scoped submission
 * blockers and warnings (Q91, Q92), resolved from the snapshot with the current override.
 */
export const submissionBlockers = (
  input: Omit<Parameters<typeof resolveForParticipation>[0], "placementAgenturKey">,
  pins: readonly { agenturKey: string }[],
) =>
  pins.map(({ agenturKey }) => {
    const { blockers, warnings } = resolveForParticipation({
      ...input,
      placementAgenturKey: agenturKey,
    });
    return {
      agenturKey,
      blockers: participantLevel(blockers),
      warnings: participantLevel(warnings),
    };
  });

/**
 * The project's snapshot and what it blocks (regional-variation.md, Blockers): the pins, the
 * project level resolved against the Project Agentur's pinned template, per pinned Agentur the
 * participant-level blockers and warnings, and the activation blockers (Q76, Q77), all resolved
 * with the current override, which is shown with its Agentur-scoped settings and approved
 * relaxations; the open relaxation requests and the rules a request may name; and what the user may
 * do here, from the route's operation check (round 26). Undefined for no project.
 */
export async function projectConfig(
  db: Db,
  release: Release,
  projectId: string,
  may: ProjectPermissions,
): Promise<ProjectConfig | undefined> {
  const snapshot = await projectSnapshot(db, release, projectId);
  if (!snapshot) return undefined;
  const { project: found, pins, override, input } = snapshot;
  const waves = await db
    .select({ latestEntryDate: projectEntryWave.latestEntryDate })
    .from(projectEntryWave)
    .where(eq(projectEntryWave.projectId, projectId));
  const projectLevel = resolveForProject(input);
  const open = await db
    .select({
      id: relaxationRequest.id,
      ruleId: relaxationRequest.ruleId,
      reasonCode: relaxationRequest.reasonCode,
      requestedBy: relaxationRequest.requestedBy,
      requestedOn: relaxationRequest.requestedOn,
    })
    .from(relaxationRequest)
    .where(
      and(eq(relaxationRequest.projectId, projectId), eq(relaxationRequest.status, "requested")),
    )
    .orderBy(asc(relaxationRequest.requestedAt), asc(relaxationRequest.id));
  return {
    projectAgenturKey: found.projectAgenturKey,
    baseDefaultsVersion: release.baseDefaults.version,
    pins: pins.map((p) => ({
      agenturKey: p.agenturKey,
      version: p.version,
      label: input.templatesByAgentur[p.agenturKey]!.label,
      sha256Prefix: p.sha256.slice(0, 12),
      pinnedAt: p.pinnedAt,
      pinnedBy: p.pinnedBy,
      // What this pin may migrate to (regional-variation.md, migration), only for a user who may
      // migrate here.
      migrationTargets: may({ kind: "migrateTemplate" })
        ? migrationTargets(release.catalog, p)
        : [],
    })),
    projectBlockers: projectLevel.blockers,
    agenturen: submissionBlockers(input, pins),
    activationBlockers: projectActivationBlockers(found, waves, projectLevel),
    override: {
      version: override.version,
      agenturSettings: Object.entries(override.content?.agenturSettings ?? {})
        .toSorted(([a], [b]) => (a < b ? -1 : 1))
        .map(([agenturKey, setting]) => ({ agenturKey, ...setting })),
      // Stored versions passed validateProjectOverride, so the codes are the controlled ones.
      relaxations: (override.content?.relax ?? [])
        .map((relaxation) => ApprovedRelaxation.parse(relaxation))
        .toSorted((a, b) => (a.ruleId < b.ruleId ? -1 : 1)),
    },
    relaxationRequests: open.map((request) => ({
      ...request,
      capabilities: {
        // Never the requester (four eyes, regional-variation.md); the API's check stays
        // authoritative.
        decide: may({ kind: "decideRelaxation", requestedBy: request.requestedBy }),
        withdraw: may({ kind: "withdrawRelaxation" }),
      },
    })),
    relaxableRules: relaxableRules(input).filter(
      ({ ruleId }) => !open.some((request) => request.ruleId === ruleId),
    ),
    capabilities: {
      pinTemplate: may({ kind: "pinTemplate" }),
      // The Project Agentur is fixed once active (Q98); further Agenturen may still be pinned.
      setProjectAgentur: may({ kind: "pinTemplate" }) && found.status === "draft",
      changeOverride: may({ kind: "changeOverride" }),
      requestRelaxation: may({ kind: "requestRelaxation" }),
      // Activation is one-way (Q98): offered only while draft.
      activateProject: may({ kind: "activateProject" }) && found.status === "draft",
      // A pinned template migrates in draft and active projects alike (regional-variation.md).
      migrateTemplate: may({ kind: "migrateTemplate" }),
      // The import works in draft and active projects alike (process-and-lifecycle.md, Dates).
      importParticipations: may({ kind: "importParticipations" }),
      // The PL while draft, the global admin at any time (Q126, `regionChangeRefusal`).
      setProjectRegion:
        may({ kind: "setProjectRegion" }) && (found.status === "draft" || may.globalAdmin),
    },
  };
}

/** The pin refusals that are a 422 (ADR-0010); `project_not_found` is a 404. */
const pinRefusals: ReadonlySet<string> = new Set([
  "template_version_changed",
  "template_already_pinned",
  "agentur_not_pinned",
  "project_not_draft",
]);

/**
 * Pins a catalog template and/or makes it the Project Agentur (regional-variation.md, "Choosing
 * the Project Agentur"), in one
 * transaction under the exclusive project lock: decides with `planTemplatePin` on the state read
 * under the lock, reads the file through `loadTemplate`, computes its canonical hash, refuses a
 * pin that would make the current override invalid (regional-variation.md, cross-chain
 * validation), then
 * `pin_agentur_template` and `update_project`. Returns null for no project, or the refusals.
 */
export async function pinTemplate(
  db: Database,
  release: Release,
  actor: { staffUserId: string; requestId: string | null },
  projectId: string,
  input: PinTemplateInput,
): Promise<true | { issues: readonly (PinIssue | string)[] } | null> {
  const context = auditContext(actor.staffUserId, actor.requestId);
  return db
    .transaction(async (tx) => {
      // The functions take the lock again (re-entrant).
      await tx.execute(sql`select lock_project_setup(${projectId}::uuid)`);
      const [found] = await tx
        .select({
          type: project.type,
          status: project.status,
          projectAgenturKey: project.projectAgenturKey,
        })
        .from(project)
        .where(eq(project.id, projectId));
      const pins = await currentPins(tx, projectId);
      const plan = planTemplatePin({ project: found!, catalog: release.catalog, pins, input });
      if ("issues" in plan) return { issues: plan.issues };
      const { agenturKey } = input;
      if (plan.pinVersion !== null) {
        const { template, sha256 } = releaseTemplate(release, agenturKey, plan.pinVersion);
        // Pinning a further Agentur keeps the override valid across every chain (2c-2 reading 3).
        const { content } = await currentOverride(tx, projectId);
        const validation = validateProjectOverride({
          base: release.baseDefaults,
          templatesByAgentur: { ...templatesOf(pins), [agenturKey]: template },
          override: content ?? { schemaVersion: 1, kind: "project_override" },
          projectType: found!.type,
        });
        if (!validation.ok) return { issues: overrideIssues(validation) };
        await callFunction(
          tx,
          sql`pin_agentur_template(p_project_id => ${projectId}::uuid,
            p_agentur_key => ${agenturKey}, p_version => ${plan.pinVersion}::integer,
            p_content => ${JSON.stringify(template)}::jsonb, p_sha256 => ${sha256},
            p_base_defaults_version => ${release.baseDefaults.version}::integer,
            p_context => ${context})`,
        );
      }
      if (plan.setProjectAgentur) {
        await callFunction(
          tx,
          sql`update_project(p_id => ${projectId}::uuid, p_project_agentur_key => ${agenturKey},
            p_context => ${context})`,
        );
      }
      return true as const;
    })
    .catch((error: unknown) => {
      const code = functionRefusal(error);
      if (code === "project_not_found") return null;
      if (code !== undefined && pinRefusals.has(code)) return { issues: [code] };
      throw error;
    });
}
