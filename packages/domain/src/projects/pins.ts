import { z } from "zod";
import { ProjectActivationBlocker } from "../lifecycle/activation";
import type { ProjectStatus } from "../project";

/** An Agentur key, as `@transfer/config`'s `AgenturKey` (the database checks it too). */
const agenturKey = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);

/**
 * Pins an Agentur template from the catalog (Slice 2 plan 5.8, R12): its latest version unless
 * the PL chooses `version`; `projectAgentur` also makes it the Project Agentur (draft only, Q98).
 * Strict: the content and hash always come from the release, never from the client.
 */
export const PinTemplateInput = z
  .strictObject({
    agenturKey,
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
      step: z.enum(["asu_registration", "agentur_submission"]),
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
  })
  .meta({ id: "ProjectConfig" });
export type ProjectConfig = z.infer<typeof ProjectConfig>;
