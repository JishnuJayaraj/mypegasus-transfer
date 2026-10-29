import { z } from "zod";
import { ProjectActivationBlocker } from "../lifecycle/activation";
import { Step } from "../lifecycle/enums";
import type { ProjectStatus } from "../project";
import { AgenturKey, TemporaryAgenturSetting } from "./agentur-settings";
import { ApprovedRelaxation, RelaxableRule, RelaxationRequest } from "./relaxations";

/**
 * Pins an Agentur template from the catalog (Slice 2 plan 5.8, R12): its latest version unless
 * the PL chooses `version`; `projectAgentur` also makes it the Project Agentur (draft only, Q98).
 * Strict: the content and hash always come from the release, never from the client.
 */
export const PinTemplateInput = z
  .strictObject({
    agenturKey: AgenturKey,
    version: z.int().min(1).optional(),
    projectAgentur: z.boolean().optional(),
  })
  .meta({ id: "PinTemplateInput" });
export type PinTemplateInput = z.infer<typeof PinTemplateInput>;

export type PinIssueCode =
  | "template_not_in_catalog"
  | "template_already_pinned"
  | "project_not_draft";
export type PinIssue = { code: PinIssueCode; field: keyof PinTemplateInput };
export type PinPlan =
  | { pinVersion: number | null; setProjectAgentur: boolean }
  | { issues: PinIssue[] };

type TemplateRef = { agenturKey: string; version: number };

/**
 * What a pin request does (R12, R1/Q98): pin the chosen version (`pinVersion`, null when the
 * Agentur is pinned already) and/or set the Project Agentur. Only catalog versions are pinned;
 * another version of a pinned Agentur is a migration with review (PR 2e-2), never a plain pin;
 * the Project Agentur changes only while draft, while further Agenturen may be pinned any time.
 */
export function planTemplatePin(state: {
  project: { status: ProjectStatus; projectAgenturKey: string | null };
  /** The release's catalog. */
  catalog: readonly TemplateRef[];
  /** The project's current pin per Agentur. */
  pins: readonly TemplateRef[];
  input: PinTemplateInput;
}): PinPlan {
  const { project, input } = state;
  const versions = state.catalog
    .filter((t) => t.agenturKey === input.agenturKey)
    .map((t) => t.version);
  if (!versions.length || (input.version !== undefined && !versions.includes(input.version))) {
    const field = versions.length ? "version" : "agenturKey";
    return { issues: [{ code: "template_not_in_catalog", field }] };
  }
  const setProjectAgentur =
    input.projectAgentur === true && project.projectAgenturKey !== input.agenturKey;
  if (setProjectAgentur && project.status !== "draft") {
    return { issues: [{ code: "project_not_draft", field: "projectAgentur" }] };
  }
  const current = state.pins.find((pin) => pin.agenturKey === input.agenturKey);
  if (!current) return { pinVersion: input.version ?? Math.max(...versions), setProjectAgentur };
  if (input.version !== undefined && input.version !== current.version) {
    return { issues: [{ code: "template_already_pinned", field: "version" }] };
  }
  if (!setProjectAgentur) {
    return { issues: [{ code: "template_already_pinned", field: "agenturKey" }] };
  }
  return { pinVersion: null, setProjectAgentur };
}

const ofAgentur = { agenturKey: z.string().nullable() };

/** A blocker or warning of the resolved configuration (Q76, Q91, Q92). */
export const ConfigBlocker = z
  .discriminatedUnion("code", [
    z.strictObject({ code: z.literal("project_activation_blocked"), ...ofAgentur }),
    z.strictObject({
      code: z.literal("agentur_submission_blocked"),
      step: Step.extract(["asu_registration", "agentur_submission"]),
      ...ofAgentur,
      missing: z.array(z.string()),
    }),
  ])
  .meta({ id: "ConfigBlocker" });

/** A project's configuration snapshot as the API returns it (plan 5.12). */
export const ProjectConfig = z
  .strictObject({
    projectAgenturKey: z.string().nullable(),
    /** The release's base defaults, which are not pinned (R10). */
    baseDefaultsVersion: z.int().min(1),
    /** The current pin per Agentur, in key order. */
    pins: z.array(
      z.strictObject({
        agenturKey: z.string(),
        version: z.int().min(1),
        label: z.strictObject({ de: z.string(), en: z.string().optional() }),
        sha256Prefix: z.string().regex(/^[0-9a-f]{12}$/),
        pinnedAt: z.iso.datetime().meta({ description: "UTC timestamp (ISO 8601)" }),
        pinnedBy: z.uuid().meta({ description: "Staff user id" }),
        /**
         * The newer catalog versions this pin may migrate to (5.8), for a user who may migrate
         * here (`capabilities.migrateTemplate`); empty otherwise.
         */
        migrationTargets: z.array(z.int().min(1)),
      }),
    ),
    /** The project level, resolved against the Project Agentur's pinned template. */
    projectBlockers: z.array(ConfigBlocker),
    /** Per pinned Agentur as a placement Agentur: the participant-level blockers and warnings. */
    agenturen: z.array(
      z.strictObject({
        agenturKey: z.string(),
        blockers: z.array(ConfigBlocker),
        warnings: z.array(ConfigBlocker),
      }),
    ),
    activationBlockers: z.array(ProjectActivationBlocker),
    /**
     * The current override version (5.9; 0 = none), part of the snapshot (R11), with its
     * Agentur-scoped settings in key order and its approved relaxations in rule order.
     */
    override: z.strictObject({
      version: z.int().min(0),
      agenturSettings: z.array(TemporaryAgenturSetting.extend({ agenturKey: AgenturKey })),
      relaxations: z.array(ApprovedRelaxation),
    }),
    /** The open relaxation requests, oldest first (5.9). */
    relaxationRequests: z.array(RelaxationRequest),
    /** The rules a relaxation may be requested for, in rule order. */
    relaxableRules: z.array(RelaxableRule),
    /**
     * What the user may do in this project, derived by the server (round 26): pin (the PL,
     * `pinTemplate`), make an Agentur the Project Agentur (the PL, while draft), change the
     * override's Agentur-scoped settings and remove an approved relaxation (the PL,
     * `changeOverride`), request a relaxation (the PL, `requestRelaxation`) and activate the
     * project (the PL, while draft, `activateProject`) and migrate a pinned template to a newer
     * version (the PL, `migrateTemplate`, draft or active); each open request says whether the
     * user may decide or withdraw it. The UI offers only these; the API's checks stay authoritative.
     */
    capabilities: z.strictObject({
      pinTemplate: z.boolean(),
      setProjectAgentur: z.boolean(),
      changeOverride: z.boolean(),
      requestRelaxation: z.boolean(),
      activateProject: z.boolean(),
      migrateTemplate: z.boolean(),
      /** Preview and confirm an import (the PL, in draft and active projects alike). */
      importParticipations: z.boolean(),
      /** Change the project's region (the PL while draft, the global admin at any time, Q126). */
      setProjectRegion: z.boolean(),
      /** The Kug 200a's header on the project (the PL of a `ta_tg` project, any status). */
      editKug200aHeader: z.boolean(),
    }),
  })
  .meta({ id: "ProjectConfig" });
export type ProjectConfig = z.infer<typeof ProjectConfig>;

/** An activation carries nothing (`POST …/activation`, a JSON body like every write); strict. */
export const ActivateProjectInput = z.strictObject({}).meta({ id: "ActivateProjectInput" });

/**
 * An activated project (plan 5.5): active since `activatedAt` (database time), with the
 * Agentur-submission blockers that don't block activation as warnings, each with its Agentur and
 * step (Q91, Q92; round 15 reading 10).
 */
export const ProjectActivation = z
  .strictObject({
    status: z.literal("active"),
    activatedAt: z.iso.datetime().meta({ description: "UTC timestamp (ISO 8601)" }),
    warnings: z.array(ConfigBlocker),
  })
  .meta({ id: "ProjectActivation" });
export type ProjectActivation = z.infer<typeof ProjectActivation>;
