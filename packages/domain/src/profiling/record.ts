import { z } from "zod";
import { compareIsoDates } from "../dates";
import { JobboerseChoice, SectionCRating } from "../forms/input";
import { isoDate, type IsoDate } from "../iso-date";
import { text, valueIssueCode } from "../self-service/values";

// The profiling record (process-and-lifecycle.md, profiling track; data-protection.md, the
// profiling record): the sessions, the pending declarations to the BA, section C with p. 7 and
// the unemployment period, as the profiler records them. Pure: the API loads and writes through
// the database functions, which check the same rules again. Every issue is a code at a path,
// never a value.

/** Storage bounds of the record (not BA rules): sessions per participation and text lengths. */
export const profilingLimits = {
  sessions: 50,
  lineText: 300,
  otherLabel: 100,
  pageText: 2000,
} as const;

const coded = (code: string) => ({ params: { code } });

/** `hh:mm`, 00:00–23:59 (ba-forms.md, validation: times `hh:mm`). */
export const ProfilingTime = z
  .string()
  .refine((value) => /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(value), coded("time_invalid"))
  .meta({ id: "ProfilingTime" });

/**
 * One profiling session as written (TL 407 section A): its date and times. An existing session
 * keeps its `id`; a new one has none, the database gives it one.
 */
export const ProfilingSessionInput = z
  .strictObject({ id: z.uuid().optional(), date: isoDate, from: ProfilingTime, to: ProfilingTime })
  .meta({ id: "ProfilingSessionInput" });
export type ProfilingSessionInput = z.infer<typeof ProfilingSessionInput>;

/** `PUT …/profiling/sessions`: every session, whole, with the record's revision (409 if stale). */
export const ProfilingSessionsInput = z
  .strictObject({
    revision: z.int().min(0),
    sessions: z.array(ProfilingSessionInput).max(profilingLimits.sessions),
  })
  .meta({ id: "ProfilingSessionsInput" });
export type ProfilingSessionsInput = z.infer<typeof ProfilingSessionsInput>;

export type ProfilingIssue = { code: string; path: (string | number)[] };

const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));

/**
 * The rules of a whole session list (process-and-lifecycle.md, the profiling record; Q193): `bis`
 * after `von` (`session_times_reversed`, equal included), no date after `today` (the Berlin date,
 * `session_in_future`), no two sessions of one day overlapping (`sessions_overlap`, at the later
 * one; touching ends are fine), no id twice (`duplicate_session`). A booked consultation is never
 * a session by itself: sessions are written only here.
 */
export function profilingSessionsProblems(
  sessions: readonly ProfilingSessionInput[],
  today: IsoDate,
): ProfilingIssue[] {
  const issues: ProfilingIssue[] = [];
  const ids = new Set<string>();
  sessions.forEach((session, index) => {
    if (session.id !== undefined) {
      if (ids.has(session.id)) issues.push({ code: "duplicate_session", path: [index, "id"] });
      ids.add(session.id);
    }
    if (minutes(session.from) >= minutes(session.to)) {
      issues.push({ code: "session_times_reversed", path: [index, "to"] });
    }
    if (compareIsoDates(session.date, today) > 0) {
      issues.push({ code: "session_in_future", path: [index, "date"] });
    }
    const overlaps = sessions
      .slice(0, index)
      .some(
        (other) =>
          other.date === session.date &&
          minutes(other.from) < minutes(session.to) &&
          minutes(session.from) < minutes(other.to),
      );
    if (overlaps) issues.push({ code: "sessions_overlap", path: [index] });
  });
  return issues;
}

/**
 * `PUT …/profiling/declarations`: the pending declarations to the BA (ba-forms.md, declarations;
 * Q44, Q193), the Jobbörse choice (TL 407 field 50) and the BA contact declaration (the contact
 * fields' note), `null` while undecided. Never the portal consent; a signed form records what was
 * actually marked (Slice 6, the TL 407).
 */
export const ProfilingDeclarationsInput = z
  .strictObject({
    revision: z.int().min(0),
    jobboerseChoice: JobboerseChoice.nullable(),
    baContactConsent: z.boolean().nullable(),
  })
  .meta({ id: "ProfilingDeclarationsInput" });
export type ProfilingDeclarationsInput = z.infer<typeof ProfilingDeclarationsInput>;

/** The section C lines with a rating and a text, in the form's order (ba-forms.md, section C). */
export const assessmentLines = [
  "schoolQualification",
  "vocationalQualification",
  "workExperience",
  "languageSkills",
  "otherQualification",
  "intellectualCapacity",
  "workAndSocialBehaviour",
  "otherPerformance",
  "initiative",
  "learningReadiness",
  "otherMotivation",
  "localMobility",
  "otherConditions",
] as const;
export type AssessmentLine = (typeof assessmentLines)[number];

/** The "andere" lines, which name what they rate. */
export const otherAssessmentLines: ReadonlySet<AssessmentLine> = new Set([
  "otherQualification",
  "otherPerformance",
  "otherMotivation",
  "otherConditions",
]);

// oxlint-disable-next-line no-control-regex -- control characters are what this refuses
const controlButNewline = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u;

/**
 * A narrative text of 1 to `max` characters (page 7): trimmed, line breaks kept, every other
 * control character refused (`control_characters`). `parseProfilingAssessment` normalises CRLF
 * and CR to `\n` first. The single-line texts keep `text`.
 */
export const multilineText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !controlButNewline.test(value), coded("control_characters"));

const line = z.strictObject({
  rating: SectionCRating.nullable(),
  text: text(profilingLimits.lineText).nullable(),
});
const otherLine = line.extend({ label: text(profilingLimits.otherLabel).nullable() });

/**
 * Section C and p. 7 (data-protection.md, the profiling record; Q192): a rating and a text per
 * line, the "andere" lines' labels, Gesamteinschätzung and weiteres Vorgehen. **The health line
 * keeps its rating only**: health detail beyond yes/no needs explicit consent
 * (data-protection.md, legal basis), which doesn't exist yet, so a text there is refused.
 */
export const ProfilingAssessment = z
  .strictObject({
    schoolQualification: line,
    vocationalQualification: line,
    workExperience: line,
    languageSkills: line,
    otherQualification: otherLine,
    health: z.strictObject({ rating: SectionCRating.nullable() }),
    intellectualCapacity: line,
    workAndSocialBehaviour: line,
    otherPerformance: otherLine,
    initiative: line,
    learningReadiness: line,
    otherMotivation: otherLine,
    localMobility: line,
    otherConditions: otherLine,
    overallAssessment: multilineText(profilingLimits.pageText).nullable(),
    nextSteps: multilineText(profilingLimits.pageText).nullable(),
  })
  .meta({ id: "ProfilingAssessment" });
export type ProfilingAssessment = z.infer<typeof ProfilingAssessment>;

/** `PUT …/profiling/assessment`: the whole assessment with its revision (409 if stale). */
export const ProfilingAssessmentInput = z
  .strictObject({
    revision: z.int().min(0),
    values: z.record(z.string(), z.unknown()).meta({
      description:
        "The whole assessment (ProfilingAssessment). The health line takes its rating only: a " +
        "text there is refused (422 health_detail_not_recorded); unknown keys are refused.",
    }),
  })
  .meta({ id: "ProfilingAssessmentInput" });

/** An assessment with every line empty. */
export function emptyAssessment(): ProfilingAssessment {
  const lines = Object.fromEntries(
    assessmentLines.map((key) => [
      key,
      otherAssessmentLines.has(key)
        ? { rating: null, text: null, label: null }
        : { rating: null, text: null },
    ]),
  );
  return {
    ...lines,
    health: { rating: null },
    overallAssessment: null,
    nextSteps: null,
  } as ProfilingAssessment;
}

const pageTexts = ["overallAssessment", "nextSteps"] as const;

/** Page 7's texts with CRLF and CR as `\n`; anything else as it came. */
function normaliseLineBreaks(values: unknown): unknown {
  if (typeof values !== "object" || values === null || Array.isArray(values)) return values;
  const record = { ...(values as Record<string, unknown>) };
  for (const key of pageTexts) {
    const value = record[key];
    if (typeof value === "string") record[key] = value.replace(/\r\n?/g, "\n");
  }
  return record;
}

/**
 * The assessment's values checked (data-protection.md, the profiling record): the parsed value, or
 * the issues by code and path. Any key on the health line but its rating is
 * `health_detail_not_recorded`, never stored.
 */
export function parseProfilingAssessment(
  values: unknown,
): { ok: true; value: ProfilingAssessment } | { ok: false; issues: ProfilingIssue[] } {
  const parsed = ProfilingAssessment.safeParse(normaliseLineBreaks(values));
  if (parsed.success) return { ok: true, value: parsed.data };
  const issues = parsed.error.issues.flatMap((issue): ProfilingIssue[] => {
    if (issue.code !== "unrecognized_keys") {
      return [{ code: valueIssueCode(issue), path: issue.path as (string | number)[] }];
    }
    const health = issue.path.length === 1 && issue.path[0] === "health";
    return issue.keys.map((key) => ({
      code: health ? "health_detail_not_recorded" : "unknown_field",
      path: [...(issue.path as (string | number)[]), key],
    }));
  });
  return { ok: false, issues };
}

/**
 * The assessment's fields, each stored, read and audited on its own (`sensitive_write`,
 * `sensitive_read` with this key): a section C line, p. 7's two texts, and the health line's
 * rating, special category in its own table (Q40).
 */
export const assessmentFieldKeys = [
  ...assessmentLines.map((key) => `profilingAssessment.${key}` as const),
  "overallAssessment",
  "nextSteps",
  "profilingHealthAssessment",
] as const;
export type AssessmentFieldKey = (typeof assessmentFieldKeys)[number];

/**
 * TL 407 fields 34 and 35, "arbeitslos seit / bis" (Q85 open: highly confidential,
 * `residence_social`, fail safe): the start and, where known, the end; `null` is none recorded.
 * A reversed range is the form's plausibility warning, not a refusal (ba-forms.md, validation).
 */
export const UnemploymentPeriod = z
  .strictObject({ from: isoDate, until: isoDate.nullable() })
  .meta({ id: "UnemploymentPeriod" });
export type UnemploymentPeriod = z.infer<typeof UnemploymentPeriod>;

/**
 * `PUT …/profiling/unemployment`: the period, or `null` to clear it, with the revision its logged
 * read returned (409 if stale, also when clearing).
 */
export const UnemploymentPeriodInput = z
  .strictObject({ revision: z.int().min(0), period: UnemploymentPeriod.nullable() })
  .meta({ id: "UnemploymentPeriodInput" });
export type UnemploymentPeriodInput = z.infer<typeof UnemploymentPeriodInput>;

/** A warning on a saved value the profiler sees; the form's readiness shows it again. */
export const ProfilingWarning = z.enum(["range_reversed"]).meta({ id: "ProfilingWarning" });
export type ProfilingWarning = z.infer<typeof ProfilingWarning>;

/** `seit` after `bis` (ba-forms.md, validation: a warning, never a refusal). */
export const unemploymentPeriodWarnings = (
  period: UnemploymentPeriod | null,
): ProfilingWarning[] =>
  period?.until != null && compareIsoDates(period.from, period.until) > 0 ? ["range_reversed"] : [];
