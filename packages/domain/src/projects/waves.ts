import { z } from "zod";
import { addDays, addMonths } from "../dates";
import { isoDate, type IsoDate } from "../iso-date";
import type { EntryWave } from "../lifecycle/waves";
import type { ProjectStatus, ProjectType } from "../project";

/** The four contractual dates of a wave (Q79), in form order. */
export const waveDateFields = [
  "signingDeadline",
  "defaultTgStart",
  "defaultTgEnd",
  "latestEntryDate",
] as const;
export type WaveDateField = (typeof waveDateFields)[number];
export type WaveField = "code" | "name" | WaveDateField;

const date = isoDate.nullable().optional();
const dates = Object.fromEntries(waveDateFields.map((field) => [field, date])) as Record<
  WaveDateField,
  typeof date
>;

/**
 * A new wave. Code and name are trimmed; their rules are `checkWaveChange`'s, so the form shows
 * them at the field like every other rule. The name is UI text and never enters the audit trail.
 * Strict: an unknown field is a validation error (round 23).
 */
export const CreateEntryWaveInput = z
  .strictObject({ code: z.string().trim(), name: z.string().trim(), ...dates })
  .meta({ id: "CreateEntryWaveInput" });
export type CreateEntryWaveInput = z.infer<typeof CreateEntryWaveInput>;

/** The fields to change, at least one; `null` clears a date. Strict. */
export const UpdateEntryWaveInput = CreateEntryWaveInput.partial()
  .refine((input) => Object.values(input).some((value) => value !== undefined), {
    message: "Change at least one field",
    params: { code: "nothing_to_change" },
  })
  .meta({ id: "UpdateEntryWaveInput" });
export type UpdateEntryWaveInput = z.infer<typeof UpdateEntryWaveInput>;

/** A wave as the API returns it, with the number of its participations. */
export const EntryWaveRecord = z
  .object({
    id: z.uuid(),
    projectId: z.uuid(),
    code: z.string(),
    name: z.string(),
    signingDeadline: isoDate.nullable(),
    defaultTgStart: isoDate.nullable(),
    defaultTgEnd: isoDate.nullable(),
    latestEntryDate: isoDate.nullable(),
    participations: z.int().min(0),
    createdAt: z.iso.datetime().meta({ description: "UTC timestamp (ISO 8601)" }),
    updatedAt: z.iso.datetime().meta({ description: "UTC timestamp (ISO 8601)" }),
  })
  .meta({ id: "EntryWave" });
export type EntryWaveRecord = z.infer<typeof EntryWaveRecord>;

export type WaveValues = Omit<EntryWave, "id"> & { name: string };

/** Read under the project lock (plan 5.6). */
export type WaveUsage = {
  participations: number;
  /** `dsv_offered` on the wave's signing deadline (no own `offerDeadline`). */
  openFirstOffers: number;
  /** A participation without its own `tgStart` that hasn't entered and isn't withdrawn. */
  reliesOnDefaultStart: boolean;
};

export type WaveChange = {
  project: { type: ProjectType; status: ProjectStatus };
  /** `null` for a new wave. */
  before: WaveValues | null;
  after: WaveValues;
  usage: WaveUsage;
  otherWaves: readonly Pick<EntryWave, "code" | "latestEntryDate">[];
  today: IsoDate;
};

export type WaveIssueCode =
  | "not_ta_tg"
  | "invalid_code"
  | "code_taken"
  | "invalid_name"
  | "signing_after_start"
  | "signing_after_latest_entry"
  | "start_after_latest_entry"
  | "end_before_start"
  | "period_exceeds_twelve_months"
  | "latest_entry_in_past"
  | "cutoff_passed"
  | "signing_deadline_in_use"
  | "default_start_passed"
  | "default_start_in_past"
  | "date_in_use"
  | "last_latest_entry_date";

/** A refused rule and the field it belongs to (`null`: the whole wave). */
export type WaveIssue = { code: WaveIssueCode; field: WaveField | null };

const codePattern = /^[A-Za-z0-9_-]{1,20}$/;
const controlCharacter = /\p{Cc}/u;

/**
 * Every rule a wave creation or edit breaks (plan 5.6; fail safe until Q101 is answered). Dates
 * are inclusive. The ordering follows the offer and entry guards (Q69): signing deadline ≤ default
 * TG start ≤ latest entry date, signing deadline ≤ latest entry date, start ≤ end, and the
 * default period is at most twelve months (R25, pending Q102). Once in use: no retroactive
 * cutoff, no change of a signing deadline open first offers depend on, a reached default TG start
 * stays (individual new start dates instead, 5.7), dates are cleared only while the wave is
 * unused and never the last latest entry date of an active project.
 */
export function checkWaveChange(change: WaveChange): WaveIssue[] {
  const { project, before, after, usage, today } = change;
  if (project.type !== "ta_tg") return [{ code: "not_ta_tg", field: null }];
  const issues: WaveIssue[] = [];
  const refuse = (code: WaveIssueCode, field: WaveField) => issues.push({ code, field });
  const changed = (field: WaveDateField) => after[field] !== (before?.[field] ?? null);
  const { signingDeadline: signing, defaultTgStart: start, defaultTgEnd: end } = after;
  const latest = after.latestEntryDate;

  if (!codePattern.test(after.code)) refuse("invalid_code", "code");
  else if (change.otherWaves.some((other) => other.code === after.code)) {
    refuse("code_taken", "code");
  }
  // In code points, as PostgreSQL's length() counts (round 24), not in UTF-16 units.
  const name = after.name;
  const length = [...name].length;
  if (name !== name.trim() || length < 1 || length > 100 || controlCharacter.test(name)) {
    refuse("invalid_name", "name");
  }

  if (signing && start && signing > start) refuse("signing_after_start", "signingDeadline");
  if (signing && latest && signing > latest) {
    refuse("signing_after_latest_entry", "signingDeadline");
  }
  if (start && latest && start > latest) refuse("start_after_latest_entry", "defaultTgStart");
  if (start && end && end < start) refuse("end_before_start", "defaultTgEnd");
  else if (start && end && end > addDays(addMonths(start, 12), -1)) {
    refuse("period_exceeds_twelve_months", "defaultTgEnd");
  }

  if (latest && changed("latestEntryDate") && latest < today) {
    refuse("latest_entry_in_past", "latestEntryDate");
  }
  const cutoff = before?.latestEntryDate;
  if (cutoff && today > cutoff && changed("latestEntryDate")) {
    refuse("cutoff_passed", "latestEntryDate");
  }
  if (usage.openFirstOffers > 0 && changed("signingDeadline")) {
    refuse("signing_deadline_in_use", "signingDeadline");
  }
  // Reached, not only passed (R29): the due run may enter participations on the start day.
  const startBefore = before?.defaultTgStart;
  if (startBefore && startBefore <= today && changed("defaultTgStart")) {
    refuse("default_start_passed", "defaultTgStart");
  }
  if (start && changed("defaultTgStart") && start < today && usage.reliesOnDefaultStart) {
    refuse("default_start_in_past", "defaultTgStart");
  }

  for (const field of waveDateFields) {
    if (before?.[field] && after[field] === null && usage.participations > 0) {
      refuse("date_in_use", field);
    }
  }
  const lastCutoff = !change.otherWaves.some((other) => other.latestEntryDate !== null);
  if (cutoff && latest === null && project.status === "active" && lastCutoff) {
    refuse("last_latest_entry_date", "latestEntryDate");
  }
  return issues;
}
