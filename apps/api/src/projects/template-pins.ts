import {
  parseLayer,
  resolveForParticipation,
  resolveForProject,
  type BaseDefaults,
  type Blocker,
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
  configTemplateVersion as templateVersion,
  desc,
  eq,
  project,
  projectEntryWave,
  projectTemplatePin as pin,
  sql,
  type Database,
} from "@transfer/db";
import {
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
 * read once at start from `CONFIG_DIR`. Base defaults are not pinned (R10); templates are, so a
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
const currentPins = (db: Db, projectId: string) =>
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

// A stored version never changes (D5), so its validated snapshot is cached by its identity.
const snapshots = new Map<string, RegionalTemplate>();

/**
 * The stored content of a pin as a template (AC-11): validated once, checked against its hash
 * and its key, then cached per (key, version, hash). The template file is never read here.
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

const participantLevel = (blockers: Blocker[]) =>
  blockers.filter((blocker) => blocker.code === "agentur_submission_blocked");

/**
 * The project's snapshot and what it blocks (plan 5.12): the pins, the project level resolved
 * against the Project Agentur's pinned template, per pinned Agentur the participant-level
 * blockers and warnings, and the activation blockers (Q76, Q77); and what the user may do here,
 * from `mayPin` (the route's `pinTemplate` check, round 26). Undefined for no project.
 */
export async function projectConfig(
  db: Db,
  release: Release,
  projectId: string,
  { mayPin }: { mayPin: boolean },
): Promise<ProjectConfig | undefined> {
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
  const waves = await db
    .select({ latestEntryDate: projectEntryWave.latestEntryDate })
    .from(projectEntryWave)
    .where(eq(projectEntryWave.projectId, projectId));
  const input = {
    base: release.baseDefaults,
    templatesByAgentur: Object.fromEntries(pins.map((p) => [p.agenturKey, snapshotOf(p)])),
    projectType: found.type,
    projectAgenturKey: found.projectAgenturKey,
  };
  const projectLevel = resolveForProject(input);
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
    })),
    projectBlockers: projectLevel.blockers,
    agenturen: pins.map(({ agenturKey }) => {
      const { blockers, warnings } = resolveForParticipation({
        ...input,
        placementAgenturKey: agenturKey,
      });
      return {
        agenturKey,
        blockers: participantLevel(blockers),
        warnings: participantLevel(warnings),
      };
    }),
    activationBlockers: projectActivationBlockers(found, waves, projectLevel),
    // The Project Agentur is fixed once active (R1, Q98); further Agenturen may still be pinned.
    capabilities: { pinTemplate: mayPin, setProjectAgentur: mayPin && found.status === "draft" },
  };
}

/** The pin refusals that are a 422 (R21, round 23); `project_not_found` is a 404. */
const pinRefusals: ReadonlySet<string> = new Set([
  "template_version_changed",
  "template_already_pinned",
  "agentur_not_pinned",
  "project_not_draft",
]);

/**
 * Pins a catalog template and/or makes it the Project Agentur (plan 5.8, R12), in one
 * transaction under the exclusive project lock: decides with `planTemplatePin` on the state read
 * under the lock, reads the file through `loadTemplate`, computes its canonical hash (R22), then
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
        .select({ status: project.status, projectAgenturKey: project.projectAgenturKey })
        .from(project)
        .where(eq(project.id, projectId));
      const pins = await currentPins(tx, projectId);
      const plan = planTemplatePin({ project: found!, catalog: release.catalog, pins, input });
      if ("issues" in plan) return { issues: plan.issues };
      const { agenturKey } = input;
      if (plan.pinVersion !== null) {
        const template = loadTemplate(agenturKey, plan.pinVersion, release.templatesDir);
        const sha256 = canonicalHash(template);
        const entry = release.catalog.find(
          (t) => t.agenturKey === agenturKey && t.version === plan.pinVersion,
        );
        // The release's files are its catalog (AC-9); a differing file is a broken image.
        if (entry?.sha256 !== sha256) throw new Error("template file differs from the manifest");
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
