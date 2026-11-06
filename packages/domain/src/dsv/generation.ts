import { z } from "zod";
import { isPrintable } from "../forms/format";
import type { TransferCompany } from "../forms/input";
import { isoDate, type IsoDate } from "../iso-date";
import type { DatedFact } from "../lifecycle/guards";
import { terminalMainStatuses, type DsvStatus, type MainStatus } from "../lifecycle/enums";
import type { ProjectStatus, ProjectType } from "../project";

// The DSV's generation (process-and-lifecycle.md, the DSV: generation; data-protection.md,
// generated forms; ADR-0009, own documents): our own versioned template pinned per project, filled
// with the three parties, the effective TG dates and the offer deadline chosen before generation.
// The generation is bound to what it printed by its source token and goes stale once a printed
// value changes or its deadline passes. The DSV is signed on paper (§623 BGB): nothing here is a
// signature. Pure; no I/O, no system time.

/** An own DSV template version, `v<n>` (`packages/forms/templates/own/dsv/v<n>/`). */
export const DsvTemplateVersion = z.string().regex(/^v[1-9][0-9]{0,3}$/);
export type DsvTemplateVersion = z.infer<typeof DsvTemplateVersion>;

/** The template's registry reference for a version. */
export const dsvTemplateRef = (version: DsvTemplateVersion) => `dsv:${version}`;

/**
 * The deadline the paper prints, chosen before generation: a first offer may take the wave's
 * signing deadline (`shown`: the date the dialog showed, compared again), a re-offer needs its
 * own (`explicit`, no default; process-and-lifecycle.md, offer deadline).
 */
export const DsvDeadlineChoice = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("wave"), shown: isoDate }),
  z.strictObject({ kind: z.literal("explicit"), date: isoDate }),
]);
export type DsvDeadlineChoice = z.infer<typeof DsvDeadlineChoice>;
export type DsvDeadlineKind = DsvDeadlineChoice["kind"];

/** A SHA-256 as lowercase hex: the source token. */
export const DsvSourceToken = z.string().regex(/^[0-9a-f]{64}$/);

export const DsvGenerationInput = z.strictObject({
  deadline: DsvDeadlineChoice,
  /** The view's source token: the printed values the user saw (`409 source_changed` otherwise). */
  expectedSourceToken: DsvSourceToken,
});
export type DsvGenerationInput = z.infer<typeof DsvGenerationInput>;

/** Everything a DSV prints except its deadline, as read in one snapshot. */
export type DsvSource = {
  templateVersion: DsvTemplateVersion;
  firstName: string;
  lastName: string;
  birthDate: IsoDate | null;
  /** The address only with its street (as `form_person` reads it), else all null. */
  street: string | null;
  postalCode: string | null;
  city: string | null;
  country: string | null;
  tgStart: IsoDate | null;
  tgEnd: IsoDate | null;
  entryWaveId: string | null;
  customerName: string;
  /** The Transfergesellschaft's fingerprint (its version is the deployment's file). */
  organisationSha256: string;
};

const sourceKeys = [
  "templateVersion",
  "firstName",
  "lastName",
  "birthDate",
  "street",
  "postalCode",
  "city",
  "country",
  "tgStart",
  "tgEnd",
  "entryWaveId",
  "customerName",
  "organisationSha256",
] as const satisfies readonly (keyof DsvSource)[];

/**
 * The canonical text the source token hashes (SHA-256, lowercase hex): the line `dsv-sources:v1`,
 * then one line per printed source in a fixed order, `key=` and the value as a JSON string or
 * `null`, joined by line feeds, as UTF-8. The database's `dsv_source_token` builds the same text
 * (a test holds them equal), so a generation is compared under the lock and its staleness read in
 * either place.
 */
export function dsvSourceCanonical(source: DsvSource): string {
  return [
    "dsv-sources:v1",
    ...sourceKeys.map((key) => `${key}=${JSON.stringify(source[key])}`),
  ].join("\n");
}

/** What decides whether a participation's DSV can be generated now. */
export type DsvGenerationState = {
  projectType: ProjectType;
  projectStatus: ProjectStatus;
  status: MainStatus;
  dsvStatus: DsvStatus;
  entryWaveId: string | null;
  tgStart: IsoDate | null;
  tgEnd: IsoDate | null;
  /** The project's pinned template version; null until the PL pins one. */
  templateVersion: DsvTemplateVersion | null;
};

export type DsvGenerationBlocker =
  | "not_ta_tg"
  | "project_not_active"
  | "participation_closed"
  | "no_entry_wave"
  | "tg_dates_missing"
  | "dsv_template_not_pinned"
  | "dsv_offer_open"
  | "dsv_already_signed";

/** The DSV tracks a new paper may be generated in: none open and none signed. */
const generatableTracks: ReadonlySet<DsvStatus> = new Set([
  "not_offered",
  "dsv_declined",
  "dsv_expired",
]);

/**
 * Why no DSV can be generated now (process-and-lifecycle.md, the DSV: generation as built): an active `ta_tg` project with a pinned template, a
 * non-terminal participation in a wave with both effective TG dates, and a DSV track without an
 * open (`dsv_offer_open`: its paper is reopened, not regenerated) or signed offer. Empty: allowed.
 */
export function dsvGenerationBlockers(state: DsvGenerationState): DsvGenerationBlocker[] {
  if (state.projectType !== "ta_tg") return ["not_ta_tg"];
  const blockers: DsvGenerationBlocker[] = [];
  if (state.projectStatus !== "active") blockers.push("project_not_active");
  if (terminalMainStatuses.has(state.status)) blockers.push("participation_closed");
  if (state.entryWaveId === null) blockers.push("no_entry_wave");
  if (state.tgStart === null || state.tgEnd === null) blockers.push("tg_dates_missing");
  if (state.templateVersion === null) blockers.push("dsv_template_not_pinned");
  if (state.dsvStatus === "dsv_offered") blockers.push("dsv_offer_open");
  else if (!generatableTracks.has(state.dsvStatus)) blockers.push("dsv_already_signed");
  return blockers;
}

/** Whether the next offer is a re-offer, which needs an explicit deadline (Q69). */
export const isDsvReoffer = (dsvStatus: DsvStatus) => dsvStatus !== "not_offered";

export type DsvDeadlineProblem =
  /** A re-offer chose the wave's deadline. */
  | "explicit_deadline_required"
  /** The wave has no signing deadline to take. */
  | "wave_deadline_missing"
  /** The wave's deadline moved since the dialog showed it (`409`). */
  | "source_changed"
  /** Not today ≤ deadline ≤ the latest entry date and ≤ the effective TG start. */
  | "offer_deadline_invalid";

export type DsvDeadlineContext = {
  today: IsoDate;
  dsvStatus: DsvStatus;
  waveSigningDeadline: IsoDate | null;
  latestEntryDate: IsoDate | null;
  tgStart: IsoDate | null;
};

/**
 * The deadline a generation prints, or why it can't (the guard `offer_deadline_valid`):
 * fails closed when the latest entry date or the TG start is missing.
 */
export function dsvDeadline(
  choice: DsvDeadlineChoice,
  context: DsvDeadlineContext,
): { ok: true; deadline: IsoDate } | { ok: false; problem: DsvDeadlineProblem } {
  let deadline: IsoDate;
  if (choice.kind === "wave") {
    if (isDsvReoffer(context.dsvStatus)) {
      return { ok: false, problem: "explicit_deadline_required" };
    }
    if (context.waveSigningDeadline === null) {
      return { ok: false, problem: "wave_deadline_missing" };
    }
    if (choice.shown !== context.waveSigningDeadline) {
      return { ok: false, problem: "source_changed" };
    }
    deadline = context.waveSigningDeadline;
  } else deadline = choice.date;
  const { today, latestEntryDate: latest, tgStart } = context;
  if (latest === null || tgStart === null || deadline < today || deadline > latest) {
    return { ok: false, problem: "offer_deadline_invalid" };
  }
  if (deadline > tgStart) return { ok: false, problem: "offer_deadline_invalid" };
  return { ok: true, deadline };
}

/** A key of the DSV's printed values, for validation and the handwriting checklist. */
export type DsvValueKey =
  | "firstName"
  | "lastName"
  | "birthDate"
  | "address"
  | "customerName"
  | "transfergesellschaft";

export type DsvValidation = {
  /** `character_unsupported`: the font can't print it; generation is refused. */
  errors: { code: "character_unsupported"; key: DsvValueKey }[];
  /** `required_blank`: left as a line for the handwriting (Q197), listed on the checklist. */
  checklist: { code: "required_blank"; key: DsvValueKey }[];
};

/**
 * The printed values checked (codes and keys, never values): every text in the embedded font's
 * printable ranges; a missing birth date or address leaves a line for handwriting and goes on the
 * checklist. Names, the customer and the TG are always present.
 */
export function validateDsvSource(
  source: Pick<
    DsvSource,
    "firstName" | "lastName" | "birthDate" | "street" | "postalCode" | "city" | "country"
  > & { customerName: string },
  company: Pick<TransferCompany, "name" | "street" | "houseNumber" | "postalCode" | "city">,
): DsvValidation {
  const texts: [DsvValueKey, (string | null)[]][] = [
    ["firstName", [source.firstName]],
    ["lastName", [source.lastName]],
    ["address", [source.street, source.postalCode, source.city, source.country]],
    ["customerName", [source.customerName]],
    [
      "transfergesellschaft",
      [company.name, company.street, company.houseNumber, company.postalCode, company.city],
    ],
  ];
  const errors: DsvValidation["errors"] = texts
    .filter(([, values]) => values.some((value) => value !== null && !isPrintable(value, false)))
    .map(([key]) => ({ code: "character_unsupported", key }));
  const checklist: DsvValidation["checklist"] = [];
  if (source.birthDate === null) checklist.push({ code: "required_blank", key: "birthDate" });
  if (source.street === null) checklist.push({ code: "required_blank", key: "address" });
  return { errors, checklist };
}

/** A generation as stored: its token, its deadline and how it was chosen. */
export type DsvGenerationRecord = {
  sourceToken: string;
  offerDeadline: IsoDate;
  deadlineKind: DsvDeadlineKind;
};

/**
 * Whether a generation can still be handed out (process-and-lifecycle.md, the DSV: generation as built): stale once a printed source value changed
 * (its token differs from the current one), its deadline passed, or, for the wave's deadline, the
 * wave's signing deadline moved. A later offer ending after it joins with the offers.
 */
export function dsvGenerationProblem(
  generation: DsvGenerationRecord,
  current: { sourceToken: string; waveSigningDeadline: IsoDate | null },
  today: IsoDate,
): "dsv_generation_stale" | null {
  if (generation.sourceToken !== current.sourceToken) return "dsv_generation_stale";
  if (generation.offerDeadline < today) return "dsv_generation_stale";
  if (
    generation.deadlineKind === "wave" &&
    generation.offerDeadline !== current.waveSigningDeadline
  ) {
    return "dsv_generation_stale";
  }
  return null;
}

/**
 * Whether a template version may be generated (ba-forms.md, the DSV as built): any in development; in production only one
 * whose manifest says `approvedForLive` (`dsv_template_not_approved`; the wording's review, Q210).
 */
export function dsvTemplateUsable(
  template: { approvedForLive: boolean },
  production: boolean,
): boolean {
  return template.approvedForLive || !production;
}

/**
 * Whether the project's pin may change (ba-forms.md, the DSV as built): only while no DSV of the project was generated
 * (`template_pinned` otherwise), only in a `ta_tg` project (`not_ta_tg`), and only to another
 * version (`project_unchanged`).
 */
export function dsvPinProblem(
  project: { type: ProjectType; pinned: DsvTemplateVersion | null; generated: boolean },
  version: DsvTemplateVersion,
): "not_ta_tg" | "template_pinned" | "project_unchanged" | null {
  if (project.type !== "ta_tg") return "not_ta_tg";
  if (project.generated) return "template_pinned";
  return project.pinned === version ? "project_unchanged" : null;
}

/**
 * `dsvGenerated` (process-and-lifecycle.md, the DSV: generation as built): the latest current generation, valid from the Berlin day it was recorded
 * and recorded at its instant; none while every generation is stale.
 */
export function dsvGeneratedFact(
  generations: readonly { generatedOn: IsoDate; generatedAt: Date; current: boolean }[],
): DatedFact | undefined {
  const latest = generations
    .filter((generation) => generation.current)
    .toSorted((a, b) => b.generatedAt.getTime() - a.generatedAt.getTime())[0];
  return latest && { validOn: latest.generatedOn, recordedAt: latest.generatedAt };
}
