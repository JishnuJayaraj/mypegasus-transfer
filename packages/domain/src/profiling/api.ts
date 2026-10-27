import { z } from "zod";
import { Tl407GeneratedForm, Tl407ScanView, Tl407SignedDeclarations } from "../forms/api";
import { FormVersion } from "../forms/field-map";
import { JobboerseChoice } from "../forms/input";
import { isoDate } from "../iso-date";
import { edges, type Edge } from "../lifecycle/edges";
import { ProfilingStatus } from "../lifecycle/enums";
import { canTransition, type TransitionContext } from "../lifecycle/transition";
import {
  assessmentFieldKeys,
  ProfilingAssessment,
  ProfilingWarning,
  UnemploymentPeriod,
} from "./record";

// The profiling record's API (ADR-0010; data-protection.md, the profiling record): the tab's view,
// built per viewer, and the profiler's logged reads. Properties a viewer may not know about are
// absent, never empty; the capabilities decide every button and the routes decide again.

const instant = z.iso.datetime().meta({ description: "UTC timestamp (ISO 8601)" });

export const ProfilingSessionView = z
  .strictObject({
    id: z.uuid(),
    date: isoDate,
    from: z.string(),
    to: z.string(),
    recordedAt: instant,
  })
  .meta({ id: "ProfilingSession" });
export type ProfilingSessionView = z.infer<typeof ProfilingSessionView>;

/** Why a track step is closed now: no permission, the project, the track, else its guard. */
export const ProfilingTransitionRefusal = z
  .enum(["forbidden", "project_not_active", "track_inactive", "tl407_signed", "before_cutoff"])
  .meta({ id: "ProfilingTransitionRefusal" });
export type ProfilingTransitionRefusal = z.infer<typeof ProfilingTransitionRefusal>;

export const ProfilingTransition = z
  .strictObject({
    to: ProfilingStatus,
    allowed: z.boolean(),
    refusal: ProfilingTransitionRefusal.nullable(),
  })
  .meta({ id: "ProfilingTransition" });
export type ProfilingTransition = z.infer<typeof ProfilingTransition>;

export const AssessmentFieldKey = z.enum(assessmentFieldKeys).meta({ id: "AssessmentFieldKey" });
export type AssessmentFieldKey = z.infer<typeof AssessmentFieldKey>;

/**
 * The tab "Profiling" (process-and-lifecycle.md, the profiling record): the track, its steps and
 * the sessions for the PL and the assigned consultant; for the assigned consultant also the
 * pending declarations, whether the unemployment period is recorded and which assessment fields
 * are, never a value of them (each comes on its own logged read).
 */
export const ProfilingView = z
  .strictObject({
    participationId: z.uuid(),
    profilingStatus: ProfilingStatus,
    /** The version `POST …/profiling-status` compares (compare-and-set). */
    statusVersion: z.int().min(0),
    profilingDoneOn: isoDate.nullable(),
    /**
     * The participation is terminal: the record is read-only (ordinary writes are refused,
     * `participation_closed`; corrections are their own workflow).
     */
    closed: z.boolean(),
    /**
     * The record's revision, which a sessions or declarations write compares (409); read in one
     * snapshot with the sessions and declarations.
     */
    revision: z.int().min(0),
    sessions: z.array(ProfilingSessionView),
    /** The pending declarations to the BA (the profiler only). */
    declarations: z
      .strictObject({
        jobboerseChoice: JobboerseChoice.nullable(),
        baContactConsent: z.boolean().nullable(),
        recordedAt: instant.nullable(),
      })
      .optional(),
    /** Section C and p. 7 (the profiler only): the revision and the recorded fields' keys. */
    assessment: z
      .strictObject({
        revision: z.int().min(0),
        recorded: z.array(AssessmentFieldKey),
        writtenAt: instant.nullable(),
      })
      .optional(),
    /** Whether "arbeitslos seit / bis" is recorded (the profiler only). */
    unemploymentPeriodRecorded: z.boolean().optional(),
    /** The generated TL 407s, latest first: metadata only (data-protection.md, generated forms). */
    tl407Forms: z.array(Tl407GeneratedForm),
    /** The signed TL 407 scans, oldest first (data-protection.md, signed scans). */
    tl407Scans: z.array(Tl407ScanView),
    /**
     * The later actual signature date of the signed TL 407 the guard counts (an accepted scan, not
     * quarantined): the default and the earliest `profilingDoneOn` (Q191); null without one.
     */
    tl407SignedOn: isoDate.nullable(),
    /** The declarations as signed on that TL 407 (the profiler only); null without one. */
    signedDeclarations: Tl407SignedDeclarations.nullable().optional(),
    /** The registry's TL 407 versions, expired ones included: external paper names one. */
    tl407Versions: z.array(FormVersion),
    /** The track's next steps from the current status. */
    transitions: z.array(ProfilingTransition),
    capabilities: z.strictObject({
      /**
       * Write the sessions, the pending declarations and the unemployment period (the profiler,
       * while the participation is open).
       */
      record: z.boolean(),
      /** Read section C and p. 7 (the profiler; a logged read). */
      readAssessment: z.boolean(),
      /** Write section C and p. 7 (the profiler, while the participation is open). */
      writeAssessment: z.boolean(),
      /** Read the unemployment period (a logged read). */
      readUnemploymentPeriod: z.boolean(),
      /** Generate the TL 407 (the profiler, while the participation is open). */
      generateTl407: z.boolean(),
      /** Read the TL 407's readiness as projected for the viewer (the profiler, the PL). */
      readTl407Readiness: z.boolean(),
      /** Upload a signed TL 407 (the assigned consultant, the PL; while the participation is open). */
      addTl407Scan: z.boolean(),
    }),
  })
  .meta({ id: "Profiling" });
export type ProfilingView = z.infer<typeof ProfilingView>;

/** `GET …/profiling/assessment`: the decrypted assessment; each field's read is audited. */
export const ProfilingAssessmentView = z
  .strictObject({
    participationId: z.uuid(),
    revision: z.int().min(0),
    values: ProfilingAssessment,
  })
  .meta({ id: "ProfilingAssessmentView" });
export type ProfilingAssessmentView = z.infer<typeof ProfilingAssessmentView>;

/**
 * `GET …/profiling/unemployment`: the decrypted period with its revision, read in one statement,
 * the read audited; an update or clearing sends the revision back (409 if stale).
 */
export const UnemploymentPeriodView = z
  .strictObject({
    participationId: z.uuid(),
    revision: z.int().min(0),
    period: UnemploymentPeriod.nullable(),
  })
  .meta({ id: "UnemploymentPeriodView" });
export type UnemploymentPeriodView = z.infer<typeof UnemploymentPeriodView>;

/**
 * The answer to a profiling write: `revision` is the token of exactly what this write stored (the
 * record's for sessions and declarations, the assessment's, the unemployment period's), which the
 * writer's editor keeps with its values; `warnings` on the saved values; `profiling` the record as
 * read afterwards, for the tab (it may already hold another writer's later change).
 */
export const ProfilingWriteResult = z
  .strictObject({
    revision: z.int().min(0),
    warnings: z.array(ProfilingWarning),
    profiling: ProfilingView,
  })
  .meta({ id: "ProfilingWriteResult" });
export type ProfilingWriteResult = z.infer<typeof ProfilingWriteResult>;

/**
 * `POST …/profiling-status` (process-and-lifecycle.md, profiling track; Q60): one step along an
 * edge of the track, with the participation's `statusVersion` (409 if stale); `effectiveDate` is
 * `profilingDoneOn` for `profiling_done`, never for another step.
 */
export const ProfilingStatusInput = z
  .strictObject({
    to: ProfilingStatus,
    effectiveDate: isoDate.optional(),
    statusVersion: z.int().min(0),
  })
  .meta({ id: "ProfilingStatusInput" });
export type ProfilingStatusInput = z.infer<typeof ProfilingStatusInput>;

/**
 * The track's manual steps from the current status (the lifecycle transitions table), each
 * allowed or closed with the first reason: the viewer's permission (`permits`), the project's
 * draft gate, then the lifecycle check with the dated facts (`track_inactive`, the guard).
 */
export function profilingTransitions(
  context: TransitionContext,
  permits: (edge: Edge) => boolean,
  projectActive: boolean,
): ProfilingTransition[] {
  const from = context.current.profilingStatus;
  return edges
    .filter((edge) => edge.track === "profiling" && edge.from === from && edge.actor === "user")
    .map((edge): ProfilingTransition => {
      const to = edge.to as ProfilingStatus;
      if (!permits(edge)) return { to, allowed: false, refusal: "forbidden" };
      if (!projectActive) return { to, allowed: false, refusal: "project_not_active" };
      const check = canTransition("profiling", from, to, context);
      if (check.ok) return { to, allowed: true, refusal: null };
      const refusal =
        check.code === "track_inactive"
          ? "track_inactive"
          : (check.failedGuards[0] as "tl407_signed" | "before_cutoff");
      return { to, allowed: false, refusal };
    });
}
