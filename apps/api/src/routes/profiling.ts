import { createRoute, z } from "@hono/zod-openapi";
import {
  and,
  asc,
  desc,
  document,
  eq,
  formGeneration,
  isNull,
  participantProfiling,
  participantProfilingAssessment,
  participantProfilingHealthAssessment,
  participantResidenceSocialData,
  participation,
  profilingSession,
  signedDeclaration,
  sql,
  type Database,
} from "@transfer/db";
import {
  assessmentLines,
  documentCapabilities,
  mayAddDocument,
  mayReadUnemploymentPeriod,
  mayRecordProfiling,
  mayUseProfilingAssessment,
  mayViewProfiling,
  parseProfilingAssessment,
  ProfilingAssessmentInput,
  ProfilingAssessmentView,
  ProfilingDeclarationsInput,
  ProfilingSessionsInput,
  profilingSessionsProblems,
  ProfilingStatusInput,
  ProfilingView,
  ProfilingWriteResult,
  UnemploymentPeriodInput,
  unemploymentPeriodWarnings,
  UnemploymentPeriodView,
  tl407ReadinessViewer,
  tl407SignedOn,
  type AssessmentFieldKey,
  type DocumentReviewState,
  type JobboerseChoice,
  type PermissionTarget,
  type ProfilingIssue,
  type StaffUser,
} from "@transfer/domain";
import type { Context } from "hono";
import { projectAccess } from "../access";
import { createRouter, json, type AppEnv, type Deps } from "../context";
import { functionRefusal } from "../database-errors";
import { fieldEncryptionKey } from "../field-encryption";
import { formRegistry } from "../forms/registry";
import { createStatusService, StatusServiceError } from "../participations/status-service";
import type { StaffSubject } from "../participations/subjects";
import { domainProblem, problem, problemResponses } from "../problem";
import { requireSession, sessionUser } from "../session";
import { auditContext, utc } from "../sql";

// The profiling record (process-and-lifecycle.md, the profiling record; data-protection.md, the
// profiling record; Q49, Q60, Q85, Q192, Q193): the tab "Profiling" for the PL and the assigned
// consultant, the profiler's writes and logged reads, and the track's steps through the status
// service. Order as in ADR-0010: schema → visibility (404, also for an unassigned consultant,
// "assigned is strict") → permission (403) → state (422, 409). Section C and the unemployment
// period are decrypted and encrypted only by the database functions, each field audited; their
// values travel only on their own `no-store` reads, never in the tab's view.

const ParticipationParams = z.object({ participationId: z.uuid() });

type Found = {
  projectId: string;
  status: string;
  profilingStatus: z.infer<typeof ProfilingView>["profilingStatus"];
  statusVersion: number;
  profilingDoneOn: string | null;
};
export type ProfilingAccess = { subject: StaffSubject; target: PermissionTarget; found: Found };
type Access = ProfilingAccess;

/** 409 with the code, for a stale revision or status version. */
const conflict = (c: Context<AppEnv>, code: string) =>
  problem(c, "conflict", { errors: [{ pointer: "", code, detail: "Read the record again" }] });

/** Domain issues at their location below `base` in the body, codes only (ADR-0010). */
const issuesAt = (base: string, issues: readonly ProfilingIssue[]) =>
  issues.map(({ code, path }) => ({ code, field: [base, ...path.map(String)].join("/") }));

/** The assessment fields with a stored value, in the domain's order. */
function recordedFields(
  row: Record<string, unknown> | undefined,
  health: { healthRatingPresent: boolean | null } | undefined,
): AssessmentFieldKey[] {
  return [
    ...assessmentLines
      .filter((line) => row?.[`${line}Present`] === true)
      .map((line) => `profilingAssessment.${line}` as const),
    ...(row?.overallAssessmentPresent ? (["overallAssessment"] as const) : []),
    ...(row?.nextStepsPresent ? (["nextSteps"] as const) : []),
    ...(health?.healthRatingPresent ? (["profilingHealthAssessment"] as const) : []),
  ];
}

const presenceColumns = Object.fromEntries(
  [...assessmentLines, "overallAssessment", "nextSteps"].map((key) => [
    `${key}Present`,
    participantProfilingAssessment[
      `${key}Present` as keyof typeof participantProfilingAssessment
    ] as typeof participantProfilingAssessment.initiativePresent,
  ]),
);

/**
 * The profiling record of one participation in **one snapshot** (data-protection.md, the profiling
 * record; ADR-0010): a read-only REPEATABLE READ transaction, whose statements all see the database
 * as of its first one, so the sessions and declarations go with the record's revision and the
 * assessment's presence with its revision; independent READ COMMITTED reads could pair old values
 * with a newer revision, and a write on that token could undo a commit without a 409. Presence
 * flags only, never a ciphertext. The sessions are read first.
 */
export async function readProfilingRecord(db: Database, participationId: string) {
  return db.transaction(
    async (tx) => {
      const sessions = await tx
        .select({
          id: profilingSession.id,
          date: profilingSession.sessionDate,
          from: profilingSession.timeFrom,
          to: profilingSession.timeTo,
          recordedAt: utc(profilingSession.recordedAt),
        })
        .from(profilingSession)
        .where(eq(profilingSession.participationId, participationId))
        .orderBy(
          asc(profilingSession.sessionDate),
          asc(profilingSession.timeFrom),
          asc(profilingSession.id),
        );
      const [record] = await tx
        .select({
          revision: participantProfiling.revision,
          jobboerseChoice: participantProfiling.jobboerseChoice,
          baContactConsent: participantProfiling.baContactConsent,
          recordedAt: utc(participantProfiling.declarationsRecordedAt),
        })
        .from(participantProfiling)
        .where(eq(participantProfiling.participationId, participationId));
      const [current] = await tx
        .select({
          status: participation.status,
          profilingStatus: participation.profilingStatus,
          statusVersion: participation.statusVersion,
          profilingDoneOn: participation.profilingDoneOn,
        })
        .from(participation)
        .where(eq(participation.id, participationId));
      const [assessment] = await tx
        .select({
          ...presenceColumns,
          revision: participantProfilingAssessment.revision,
          writtenAt: utc(participantProfilingAssessment.writtenAt),
        })
        .from(participantProfilingAssessment)
        .where(eq(participantProfilingAssessment.participationId, participationId));
      const [health] = await tx
        .select({ healthRatingPresent: participantProfilingHealthAssessment.healthRatingPresent })
        .from(participantProfilingHealthAssessment)
        .where(eq(participantProfilingHealthAssessment.participationId, participationId));
      const [residence] = await tx
        .select({ present: participantResidenceSocialData.unemploymentPeriodPresent })
        .from(participantResidenceSocialData)
        .where(eq(participantResidenceSocialData.participationId, participationId));
      // The generated TL 407s whose file is live, latest first (data-protection.md, generated forms).
      const tl407Forms = await tx
        .select({
          documentId: formGeneration.documentId,
          formVersion: formGeneration.formVersion,
          generatedAt: utc(formGeneration.generatedAt),
          anlage: formGeneration.anlage,
          reviewState: document.reviewState,
        })
        .from(formGeneration)
        .innerJoin(document, eq(document.id, formGeneration.documentId))
        .where(
          and(
            eq(formGeneration.participationId, participationId),
            eq(formGeneration.formCode, "tl407"),
            isNull(document.deletedAt),
          ),
        )
        .orderBy(desc(formGeneration.generatedAt), desc(formGeneration.id));
      // The signed TL 407 scans, oldest first (data-protection.md, signed scans).
      const tl407Scans = await tx
        .select({
          documentId: document.id,
          origin: document.scanOrigin,
          generationDocumentId: document.generationDocumentId,
          formVersion: document.formVersion,
          addedAt: utc(document.addedAt),
          reviewState: document.reviewState,
          reviewReason: document.reviewReason,
          reviewedAt: utc(document.reviewedAt),
          participantSignedOn: document.signedOn,
          profilerSignedOn: document.countersignedOn,
          quarantineReason: document.quarantineReason,
          quarantinedBy: document.quarantinedBy,
          quarantinedAt: utc(document.quarantinedAt),
          // Whether a fact may rest on it, and from when (`tl407_evidence`).
          counts: sql<boolean>`${document.reviewState} = 'accepted'
            and ${document.quarantinedAt} is null and ${document.invalidatedByCorrection} is null`,
          countsFrom: sql<string | null>`to_char(greatest(${document.reviewedAt},
            coalesce(${document.quarantineLiftedAt}, ${document.reviewedAt})) at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        })
        .from(document)
        .where(
          and(
            eq(document.participationId, participationId),
            eq(document.type, "tl407_signed_scan"),
            isNull(document.deletedAt),
          ),
        )
        .orderBy(asc(document.addedAt), asc(document.id));
      // The usable scans (`tl407_facts`): accepted, not quarantined, not invalidated. The guard
      // counts the earliest signed one; the current signed declarations are the latest paper's.
      const usable = tl407Scans
        .filter((row) => row.counts)
        .map((row) => ({ ...row, signedOn: tl407SignedOn(row as Signed) }));
      const earliest = usable.toSorted(
        (a, b) =>
          a.signedOn.localeCompare(b.signedOn) ||
          a.countsFrom!.localeCompare(b.countsFrom!) ||
          a.documentId.localeCompare(b.documentId),
      )[0];
      const latest = usable.toSorted(
        (a, b) =>
          b.signedOn.localeCompare(a.signedOn) ||
          b.reviewedAt!.localeCompare(a.reviewedAt!) ||
          b.documentId.localeCompare(a.documentId),
      )[0];
      const declarations = latest
        ? await tx
            .select({ declaration: signedDeclaration.declaration, value: signedDeclaration.value })
            .from(signedDeclaration)
            .where(eq(signedDeclaration.documentId, latest.documentId))
        : [];
      // A recorded completion is supported only by a usable scan signed by its date.
      const doneOn = current!.profilingDoneOn;
      return {
        profilingStatus: current!.profilingStatus,
        statusVersion: current!.statusVersion,
        profilingDoneOn: current!.profilingDoneOn,
        closed: closedStatuses.has(current!.status),
        revision: record?.revision ?? 0,
        sessions,
        declarations: {
          jobboerseChoice: record?.jobboerseChoice ?? null,
          baContactConsent: record?.baContactConsent ?? null,
          recordedAt: record?.recordedAt ?? null,
        },
        unemploymentPeriodRecorded: residence?.present ?? false,
        assessment: {
          revision: (assessment?.revision as number | undefined) ?? 0,
          recorded: recordedFields(assessment as Record<string, unknown> | undefined, health),
          writtenAt: (assessment?.writtenAt as string | undefined) ?? null,
        },
        tl407Forms,
        tl407Scans,
        tl407SignedOn: earliest?.signedOn ?? null,
        profilingDoneSupported:
          doneOn === null ? null : usable.some((scan) => scan.signedOn <= doneOn),
        signed: latest && {
          documentId: latest.documentId,
          formVersion: latest.formVersion!,
          signedOn: latest.signedOn,
          acceptedAt: latest.reviewedAt!,
          jobboerseChoice: (declarations.find((d) => d.declaration === "jobboerseChoice")?.value ??
            null) as JobboerseChoice | null,
          baContactConsent: valueOf(declarations.find((d) => d.declaration === "baContactConsent")),
        },
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

/** An accepted scan's actual signature dates. */
type Signed = { participantSignedOn: string; profilerSignedOn: string };

/** The BA contact declaration as stored (`yes` / `no`), or null where nothing is marked. */
const valueOf = (row: { value: string | null } | undefined) =>
  row?.value === "yes" ? true : row?.value === "no" ? false : null;

/** The terminal statuses: the record takes no ordinary writes (`participation_closed`). */
export const closedStatuses: ReadonlySet<string> = new Set(["withdrawn", "ta_completed", "exited"]);

/** A refusal of the profiling functions as its problem, or rethrown. */
function refused(c: Context<AppEnv>, error: unknown) {
  const code = functionRefusal(error);
  if (code === "stale_revision") return conflict(c, code);
  if (code === "actor_not_allowed") return problem(c, "forbidden");
  if (
    code === "participation_closed" ||
    code === "health_detail_not_recorded" ||
    code === "session_times_reversed" ||
    code === "session_in_future" ||
    code === "sessions_overlap" ||
    code === "session_not_found"
  ) {
    return domainProblem(c, [code]);
  }
  throw error;
}

/** The staff user acting for themselves in this request. */
const context = (c: Context<AppEnv>, user: StaffUser = sessionUser(c)) =>
  auditContext(user.id, c.get("requestId") as string);

/**
 * The participation and the viewer's access to its profiling: a 404 for no participation, a
 * project the viewer can't see, or an unassigned consultant; a 403 for a role without the tab.
 */
export async function profilingAccess(
  db: Database,
  c: Context<AppEnv>,
  participationId: string,
): Promise<{ ok: true; access: Access } | { ok: false; response: Response }> {
  const [found] = await db
    .select({
      projectId: participation.projectId,
      status: participation.status,
      profilingStatus: participation.profilingStatus,
      statusVersion: participation.statusVersion,
      profilingDoneOn: participation.profilingDoneOn,
    })
    .from(participation)
    .where(eq(participation.id, participationId));
  if (!found) return { ok: false, response: problem(c, "not-found") };
  const { subject, visible, regionId } = await projectAccess(db, sessionUser(c), found.projectId);
  if (!visible) return { ok: false, response: problem(c, "not-found") };
  const target = { projectId: found.projectId, regionId, participationId };
  const view = mayViewProfiling(subject, target);
  if (!view.ok) {
    const hidden = view.because === "not_assigned";
    return { ok: false, response: problem(c, hidden ? "not-found" : "forbidden") };
  }
  return { ok: true, access: { subject, target, found } };
}

export function profilingRoutes(deps: Deps) {
  const { db, clock } = deps;
  const router = createRouter();
  const middleware = [requireSession(deps)];
  const statusService = createStatusService({ db, clock });
  const fieldKey = fieldEncryptionKey(deps.env.fieldEncryptionKey!);
  const registry = deps.formRegistry ?? formRegistry(deps.env.configDir);
  const access = (c: Context<AppEnv>, participationId: string) =>
    profilingAccess(db, c, participationId);

  /** Calls a write function; its result is the revision of exactly what it stored. */
  async function stored(query: ReturnType<typeof sql>): Promise<number> {
    const { rows } = await db.execute<{ result: number }>(query);
    return rows[0]!.result;
  }

  /**
   * The tab's view for the viewer (ProfilingView): absent where they may not know about it. The
   * record is read in one snapshot (`readProfilingRecord`), so every value goes with the
   * revision it was written under.
   */
  async function viewOf({ subject, target }: Access): Promise<z.infer<typeof ProfilingView>> {
    const participationId = target.participationId!;
    const [record, transitions] = await Promise.all([
      readProfilingRecord(db, participationId),
      statusService.profilingTransitions(subject, participationId),
    ]);
    const records = mayRecordProfiling(subject, target).ok;
    const assesses = mayUseProfilingAssessment(subject, target, "read");
    const open = !record.closed;
    const today = clock.today();
    const documentTarget = target as PermissionTarget & { participationId: string };
    const normal = { kind: "normal" } as const;
    // A scan is reviewed only while the participation is open (`participation_closed`).
    const scanCapabilities = (reviewState: DocumentReviewState, quarantinedBy: string | null) => {
      const capabilities = documentCapabilities(subject, documentTarget, normal, {
        type: "tl407_signed_scan",
        addedByParticipant: false,
        reviewState,
        quarantinedBy,
      });
      return { ...capabilities, review: capabilities.review && open };
    };
    const opens = (reviewState: DocumentReviewState) =>
      documentCapabilities(subject, documentTarget, normal, {
        type: "tl407_form",
        addedByParticipant: false,
        reviewState,
        quarantinedBy: null,
      }).open;
    return {
      participationId,
      profilingStatus: record.profilingStatus,
      statusVersion: record.statusVersion,
      profilingDoneOn: record.profilingDoneOn,
      closed: record.closed,
      revision: record.revision,
      sessions: record.sessions,
      ...(records && {
        declarations: record.declarations,
        unemploymentPeriodRecorded: record.unemploymentPeriodRecorded,
      }),
      ...(assesses && { assessment: record.assessment }),
      tl407Forms: record.tl407Forms.map(({ reviewState, ...form }, index) => ({
        ...form,
        latest: index === 0,
        versionInUse: registry.versionInUse("tl407", form.formVersion, today),
        capabilities: { open: opens(reviewState) },
      })),
      tl407Scans: record.tl407Scans.map((scan) => ({
        documentId: scan.documentId,
        origin: scan.origin!,
        generationDocumentId: scan.generationDocumentId,
        formVersion: scan.formVersion,
        addedAt: scan.addedAt,
        review: {
          state: scan.reviewState,
          reasonCode: scan.reviewReason,
          reviewedAt: scan.reviewedAt,
        },
        participantSignedOn: scan.participantSignedOn,
        profilerSignedOn: scan.profilerSignedOn,
        quarantine:
          scan.quarantineReason === null
            ? null
            : { reasonCode: scan.quarantineReason, quarantinedAt: scan.quarantinedAt! },
        capabilities: scanCapabilities(scan.reviewState, scan.quarantinedBy),
      })),
      tl407SignedOn: record.tl407SignedOn,
      profilingDoneSupported: record.profilingDoneSupported,
      ...(records && { signedDeclarations: record.signed ?? null }),
      tl407Versions: registry.versions("tl407"),
      transitions,
      capabilities: {
        record: records && open,
        readAssessment: assesses,
        writeAssessment: open && mayUseProfilingAssessment(subject, target, "write"),
        readUnemploymentPeriod: mayReadUnemploymentPeriod(subject, target),
        generateTl407: records && open,
        readTl407Readiness: tl407ReadinessViewer(subject, target) !== null,
        addTl407Scan:
          open && mayAddDocument(subject, "tl407_signed_scan", documentTarget, normal).ok,
      },
    };
  }

  /** A write's answer: the revision of what it stored, its warnings and the record afterwards. */
  async function written(
    viewer: Access,
    revision: number,
    warnings: z.infer<typeof ProfilingWriteResult>["warnings"] = [],
  ): Promise<z.infer<typeof ProfilingWriteResult>> {
    return { revision, warnings, profiling: await viewOf(viewer) };
  }

  /** The profiler's write: the access, then the permission (403); else a refusal. */
  async function profilerAccess(c: Context<AppEnv>, participationId: string) {
    const result = await access(c, participationId);
    if (!result.ok) return result;
    if (!mayRecordProfiling(result.access.subject, result.access.target).ok) {
      return { ok: false as const, response: problem(c, "forbidden") };
    }
    return result;
  }

  router.openapi(
    createRoute({
      method: "get",
      path: "/participations/{participationId}/profiling",
      tags: ["participations"],
      summary:
        "The tab Profiling: the track and its next steps, the sessions; for the assigned consultant the pending declarations and which assessment fields are recorded (never a value)",
      middleware,
      request: { params: ParticipationParams },
      responses: {
        200: json(ProfilingView, "The profiling record as the viewer may know it"),
        ...problemResponses("validation-error", "unauthenticated", "forbidden", "not-found"),
      },
    }),
    async (c) => {
      const result = await access(c, c.req.valid("param").participationId);
      if (!result.ok) return result.response as never;
      c.header("Cache-Control", "no-store");
      return c.json(await viewOf(result.access), 200);
    },
  );

  router.openapi(
    createRoute({
      method: "put",
      path: "/participations/{participationId}/profiling/sessions",
      tags: ["participations"],
      summary:
        "Write every profiling session whole (the assigned consultant): bis after von, no future date, no overlap on one day; 409 stale_revision",
      middleware,
      request: {
        params: ParticipationParams,
        body: {
          required: true,
          content: { "application/json": { schema: ProfilingSessionsInput } },
        },
      },
      responses: {
        200: json(ProfilingWriteResult, "Saved: the record's revision of these sessions"),
        ...problemResponses(
          "validation-error",
          "unauthenticated",
          "forbidden",
          "not-found",
          "conflict",
          "domain-error",
        ),
      },
    }),
    async (c) => {
      const { participationId } = c.req.valid("param");
      const input = c.req.valid("json");
      const result = await profilerAccess(c, participationId);
      if (!result.ok) return result.response as never;
      const issues = profilingSessionsProblems(input.sessions, clock.today());
      if (issues.length > 0) return domainProblem(c, issuesAt("sessions", issues));
      let revision: number;
      try {
        revision = await stored(sql`select write_profiling_sessions(
          p_participation_id => ${participationId}::uuid, p_context => ${context(c)},
          p_sessions => ${JSON.stringify(input.sessions)}::jsonb,
          p_revision => ${input.revision}::integer) as result`);
      } catch (error) {
        return refused(c, error);
      }
      c.header("Cache-Control", "no-store");
      return c.json(await written(result.access, revision), 200);
    },
  );

  router.openapi(
    createRoute({
      method: "put",
      path: "/participations/{participationId}/profiling/declarations",
      tags: ["participations"],
      summary:
        "Write the pending declarations to the BA (the assigned consultant): the Jobbörse choice and the BA contact declaration; never the portal consent; 409 stale_revision",
      middleware,
      request: {
        params: ParticipationParams,
        body: {
          required: true,
          content: { "application/json": { schema: ProfilingDeclarationsInput } },
        },
      },
      responses: {
        200: json(ProfilingWriteResult, "Saved: the record's revision of these declarations"),
        ...problemResponses(
          "validation-error",
          "unauthenticated",
          "forbidden",
          "not-found",
          "conflict",
          "domain-error",
        ),
      },
    }),
    async (c) => {
      const { participationId } = c.req.valid("param");
      const input = c.req.valid("json");
      const result = await profilerAccess(c, participationId);
      if (!result.ok) return result.response as never;
      let revision: number;
      try {
        revision = await stored(sql`select write_profiling_declarations(
          p_participation_id => ${participationId}::uuid, p_context => ${context(c)},
          p_jobboerse_choice => ${input.jobboerseChoice}::jobboerse_choice,
          p_ba_contact_consent => ${input.baContactConsent}::boolean,
          p_revision => ${input.revision}::integer) as result`);
      } catch (error) {
        return refused(c, error);
      }
      c.header("Cache-Control", "no-store");
      return c.json(await written(result.access, revision), 200);
    },
  );

  router.openapi(
    createRoute({
      method: "get",
      path: "/participations/{participationId}/profiling/assessment",
      tags: ["participations"],
      summary:
        "Section C and p. 7 decrypted for the assigned consultant; each field's read is audited (sensitive_read)",
      middleware,
      request: { params: ParticipationParams },
      responses: {
        200: json(ProfilingAssessmentView, "The assessment and its revision"),
        ...problemResponses("validation-error", "unauthenticated", "forbidden", "not-found"),
      },
    }),
    async (c) => {
      const { participationId } = c.req.valid("param");
      const result = await access(c, participationId);
      if (!result.ok) return result.response as never;
      const { subject, target } = result.access;
      if (!mayUseProfilingAssessment(subject, target, "read")) return problem(c, "forbidden");
      let read: { revision: number; values: z.infer<typeof ProfilingAssessmentView>["values"] };
      try {
        const { rows } = await db.execute<{ result: typeof read }>(
          sql`select read_profiling_assessment(p_participation_id => ${participationId}::uuid,
            p_context => ${context(c)}, p_key => ${fieldKey.key},
            p_key_id => ${fieldKey.keyId}) as result`,
        );
        read = rows[0]!.result;
      } catch (error) {
        if (functionRefusal(error) === "actor_not_allowed") return problem(c, "forbidden");
        throw error;
      }
      c.header("Cache-Control", "no-store");
      return c.json({ participationId, ...read }, 200);
    },
  );

  router.openapi(
    createRoute({
      method: "put",
      path: "/participations/{participationId}/profiling/assessment",
      tags: ["participations"],
      summary:
        "Write section C and p. 7 whole, encrypted (the assigned consultant); each changed field is audited (sensitive_write). The health line takes its rating only (422 health_detail_not_recorded); 409 stale_revision",
      middleware,
      request: {
        params: ParticipationParams,
        body: {
          required: true,
          content: { "application/json": { schema: ProfilingAssessmentInput } },
        },
      },
      responses: {
        200: json(ProfilingWriteResult, "Saved: the assessment's revision of these values"),
        ...problemResponses(
          "validation-error",
          "unauthenticated",
          "forbidden",
          "not-found",
          "conflict",
          "domain-error",
        ),
      },
    }),
    async (c) => {
      const { participationId } = c.req.valid("param");
      const input = c.req.valid("json");
      const result = await access(c, participationId);
      if (!result.ok) return result.response as never;
      const { subject, target } = result.access;
      if (!mayUseProfilingAssessment(subject, target, "write")) return problem(c, "forbidden");
      const parsed = parseProfilingAssessment(input.values);
      if (!parsed.ok) return domainProblem(c, issuesAt("values", parsed.issues));
      let revision: number;
      try {
        revision = await stored(sql`select write_profiling_assessment(
          p_participation_id => ${participationId}::uuid, p_context => ${context(c)},
          p_values => ${JSON.stringify(parsed.value)}::jsonb,
          p_revision => ${input.revision}::integer, p_key => ${fieldKey.key},
          p_key_id => ${fieldKey.keyId}) as result`);
      } catch (error) {
        return refused(c, error);
      }
      c.header("Cache-Control", "no-store");
      return c.json(await written(result.access, revision), 200);
    },
  );

  router.openapi(
    createRoute({
      method: "get",
      path: "/participations/{participationId}/profiling/unemployment",
      tags: ["participations"],
      summary:
        "The unemployment period decrypted with its revision (the assigned consultant, back office); the read is audited (sensitive_read)",
      middleware,
      request: { params: ParticipationParams },
      responses: {
        200: json(UnemploymentPeriodView, "The period, or null"),
        ...problemResponses("validation-error", "unauthenticated", "forbidden", "not-found"),
      },
    }),
    async (c) => {
      const { participationId } = c.req.valid("param");
      const [found] = await db
        .select({ projectId: participation.projectId })
        .from(participation)
        .where(eq(participation.id, participationId));
      if (!found) return problem(c, "not-found");
      const user = sessionUser(c);
      const { subject, visible, regionId } = await projectAccess(db, user, found.projectId);
      if (!visible) return problem(c, "not-found");
      const target = { projectId: found.projectId, regionId, participationId };
      // Back office reads it without the tab, like the other residence and social answers.
      if (!mayReadUnemploymentPeriod(subject, target)) {
        const hidden = mayViewProfiling(subject, target);
        return problem(
          c,
          !hidden.ok && hidden.because === "not_assigned" ? "not-found" : "forbidden",
        );
      }
      // The value and its revision from one row read, the read audited.
      let read: Omit<z.infer<typeof UnemploymentPeriodView>, "participationId">;
      try {
        const { rows } = await db.execute<{ result: typeof read }>(
          sql`select read_unemployment_period(p_participation_id => ${participationId}::uuid,
            p_context => ${context(c, user)}, p_key => ${fieldKey.key},
            p_key_id => ${fieldKey.keyId}) as result`,
        );
        read = rows[0]!.result;
      } catch (error) {
        if (functionRefusal(error) === "actor_not_allowed") return problem(c, "forbidden");
        throw error;
      }
      c.header("Cache-Control", "no-store");
      return c.json({ participationId, ...read }, 200);
    },
  );

  router.openapi(
    createRoute({
      method: "put",
      path: "/participations/{participationId}/profiling/unemployment",
      tags: ["participations"],
      summary:
        "Write the unemployment period, encrypted (the assigned consultant), or clear it, with the revision of its read (409 stale_revision); audited (sensitive_write)",
      middleware,
      request: {
        params: ParticipationParams,
        body: {
          required: true,
          content: { "application/json": { schema: UnemploymentPeriodInput } },
        },
      },
      responses: {
        200: json(ProfilingWriteResult, "Saved: the period's revision, a reversed range warned"),
        ...problemResponses(
          "validation-error",
          "unauthenticated",
          "forbidden",
          "not-found",
          "conflict",
          "domain-error",
        ),
      },
    }),
    async (c) => {
      const { participationId } = c.req.valid("param");
      const { period, revision: expected } = c.req.valid("json");
      const result = await profilerAccess(c, participationId);
      if (!result.ok) return result.response as never;
      let revision: number;
      try {
        revision = await stored(sql`select write_unemployment_period(
          p_participation_id => ${participationId}::uuid, p_context => ${context(c)},
          p_period => ${JSON.stringify(period)}::jsonb, p_revision => ${expected}::integer,
          p_key => ${fieldKey.key},
          p_key_id => ${fieldKey.keyId}) as result`);
      } catch (error) {
        return refused(c, error);
      }
      c.header("Cache-Control", "no-store");
      return c.json(
        await written(result.access, revision, unemploymentPeriodWarnings(period)),
        200,
      );
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/participations/{participationId}/profiling-status",
      tags: ["participations"],
      summary:
        "One step of the profiling track along its edges (the PL, the assigned consultant) through the status service; 409 stale_status, 422 with the failed guard",
      middleware,
      request: {
        params: ParticipationParams,
        body: {
          required: true,
          content: { "application/json": { schema: ProfilingStatusInput } },
        },
      },
      responses: {
        200: json(ProfilingView, "Changed; the profiling record"),
        ...problemResponses(
          "validation-error",
          "unauthenticated",
          "forbidden",
          "not-found",
          "conflict",
          "domain-error",
        ),
      },
    }),
    async (c) => {
      const { participationId } = c.req.valid("param");
      const input = c.req.valid("json");
      const result = await access(c, participationId);
      if (!result.ok) return result.response as never;
      const { subject, found } = result.access;
      try {
        await statusService.changeStatus(
          subject,
          {
            participationId,
            track: "profiling",
            from: found.profilingStatus,
            to: input.to,
            expectedVersion: input.statusVersion,
            ...(input.effectiveDate !== undefined && { effectiveDate: input.effectiveDate }),
          },
          { requestId: c.get("requestId") as string },
        );
      } catch (error) {
        if (!(error instanceof StatusServiceError)) throw error;
        if (error.kind === "not_found") return problem(c, "not-found");
        if (error.kind === "forbidden") return problem(c, "forbidden");
        if (error.kind === "stale") return conflict(c, error.code);
        return domainProblem(c, error.failedGuards.length > 0 ? error.failedGuards : [error.code]);
      }
      c.header("Cache-Control", "no-store");
      return c.json(await viewOf(result.access), 200);
    },
  );

  return router;
}
