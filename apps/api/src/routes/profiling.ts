import { createRoute, z } from "@hono/zod-openapi";
import {
  asc,
  eq,
  participantProfiling,
  participantProfilingAssessment,
  participantProfilingHealthAssessment,
  participantResidenceSocialData,
  participation,
  profilingSession,
  sql,
} from "@transfer/db";
import {
  assessmentLines,
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
  UnemploymentPeriodInput,
  UnemploymentPeriodView,
  type AssessmentFieldKey,
  type PermissionTarget,
  type ProfilingIssue,
  type StaffUser,
} from "@transfer/domain";
import type { Context } from "hono";
import { projectAccess } from "../access";
import { createRouter, json, type AppEnv, type Deps } from "../context";
import { functionRefusal } from "../database-errors";
import { fieldEncryptionKey } from "../field-encryption";
import { createStatusService, StatusServiceError } from "../participations/status-service";
import type { StaffSubject } from "../participations/subjects";
import { domainProblem, problem, problemResponses } from "../problem";
import { requireSession, sessionUser } from "../session";
import { auditContext, utc } from "../sql";
import { textArray } from "./self-service";

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
  profilingStatus: z.infer<typeof ProfilingView>["profilingStatus"];
  statusVersion: number;
  profilingDoneOn: string | null;
};
type Access = { subject: StaffSubject; target: PermissionTarget; found: Found };

/** 409 with the code, for a stale revision or status version. */
const conflict = (c: Context<AppEnv>, code: string) =>
  problem(c, "conflict", { errors: [{ pointer: "", code, detail: "Read the record again" }] });

/** Domain issues at their location below `base` in the body, codes only (ADR-0010). */
const issuesAt = (base: string, issues: readonly ProfilingIssue[]) =>
  issues.map(({ code, path }) => ({ code, field: [base, ...path.map(String)].join("/") }));

/** The assessment fields with a stored value, in the domain's order. */
function recordedFields(
  row: Partial<typeof participantProfilingAssessment.$inferSelect> | undefined,
  health: { healthRatingPresent: boolean | null } | undefined,
): AssessmentFieldKey[] {
  const present = row as Record<string, unknown> | undefined;
  return [
    ...assessmentLines
      .filter((line) => present?.[`${line}Present`] === true)
      .map((line) => `profilingAssessment.${line}` as const),
    ...(present?.overallAssessmentPresent ? (["overallAssessment"] as const) : []),
    ...(present?.nextStepsPresent ? (["nextSteps"] as const) : []),
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

export function profilingRoutes(deps: Deps) {
  const { db, clock } = deps;
  const router = createRouter();
  const middleware = [requireSession(deps)];
  const statusService = createStatusService({ db, clock });
  const fieldKey = fieldEncryptionKey(deps.env.fieldEncryptionKey!);

  /**
   * The participation and the viewer's access to its profiling: a 404 for no participation, a
   * project the viewer can't see, or an unassigned consultant; a 403 for a role without the tab.
   */
  async function access(
    c: Context<AppEnv>,
    participationId: string,
  ): Promise<{ ok: true; access: Access } | { ok: false; response: Response }> {
    const [found] = await db
      .select({
        projectId: participation.projectId,
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

  /** The tab's view for the viewer (ProfilingView): absent where they may not know about it. */
  async function viewOf({ subject, target }: Access): Promise<z.infer<typeof ProfilingView>> {
    const participationId = target.participationId!;
    const [[current], sessions, [record], [assessment], [health], [residence], transitions] =
      await Promise.all([
        db
          .select({
            profilingStatus: participation.profilingStatus,
            statusVersion: participation.statusVersion,
            profilingDoneOn: participation.profilingDoneOn,
          })
          .from(participation)
          .where(eq(participation.id, participationId)),
        db
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
          ),
        db
          .select({
            revision: participantProfiling.revision,
            jobboerseChoice: participantProfiling.jobboerseChoice,
            baContactConsent: participantProfiling.baContactConsent,
            recordedAt: utc(participantProfiling.declarationsRecordedAt),
          })
          .from(participantProfiling)
          .where(eq(participantProfiling.participationId, participationId)),
        db
          .select({
            ...presenceColumns,
            revision: participantProfilingAssessment.revision,
            writtenAt: utc(participantProfilingAssessment.writtenAt),
          })
          .from(participantProfilingAssessment)
          .where(eq(participantProfilingAssessment.participationId, participationId)),
        db
          .select({ healthRatingPresent: participantProfilingHealthAssessment.healthRatingPresent })
          .from(participantProfilingHealthAssessment)
          .where(eq(participantProfilingHealthAssessment.participationId, participationId)),
        db
          .select({ present: participantResidenceSocialData.unemploymentPeriodPresent })
          .from(participantResidenceSocialData)
          .where(eq(participantResidenceSocialData.participationId, participationId)),
        statusService.profilingTransitions(subject, participationId),
      ]);
    const records = mayRecordProfiling(subject, target).ok;
    const assesses = mayUseProfilingAssessment(subject, target, "read");
    return {
      participationId,
      profilingStatus: current!.profilingStatus,
      statusVersion: current!.statusVersion,
      profilingDoneOn: current!.profilingDoneOn,
      revision: record?.revision ?? 0,
      sessions,
      ...(records && {
        declarations: {
          jobboerseChoice: record?.jobboerseChoice ?? null,
          baContactConsent: record?.baContactConsent ?? null,
          recordedAt: record?.recordedAt ?? null,
        },
        unemploymentPeriodRecorded: residence?.present ?? false,
      }),
      ...(assesses && {
        assessment: {
          revision: (assessment?.revision as number | undefined) ?? 0,
          recorded: recordedFields(assessment, health),
          writtenAt: (assessment?.writtenAt as string | undefined) ?? null,
        },
      }),
      transitions,
      capabilities: {
        record: records,
        assessment: assesses && mayUseProfilingAssessment(subject, target, "write"),
        readUnemploymentPeriod: mayReadUnemploymentPeriod(subject, target),
      },
    };
  }

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

  /** The profiler's write: the access, then the permission (403); else a refusal. */
  async function profilerAccess(c: Context<AppEnv>, participationId: string) {
    const result = await access(c, participationId);
    if (!result.ok) return result;
    if (!mayRecordProfiling(result.access.subject, result.access.target).ok) {
      return { ok: false as const, response: problem(c, "forbidden") };
    }
    return result;
  }

  const context = (c: Context<AppEnv>, user: StaffUser = sessionUser(c)) =>
    auditContext(user.id, c.get("requestId") as string);

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
        200: json(ProfilingView, "Saved; the profiling record"),
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
      try {
        await db.execute(sql`select write_profiling_sessions(
          p_participation_id => ${participationId}::uuid, p_context => ${context(c)},
          p_sessions => ${JSON.stringify(input.sessions)}::jsonb,
          p_revision => ${input.revision}::integer) as result`);
      } catch (error) {
        return refused(c, error);
      }
      c.header("Cache-Control", "no-store");
      return c.json(await viewOf(result.access), 200);
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
        200: json(ProfilingView, "Saved; the profiling record"),
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
      try {
        await db.execute(sql`select write_profiling_declarations(
          p_participation_id => ${participationId}::uuid, p_context => ${context(c)},
          p_jobboerse_choice => ${input.jobboerseChoice}::jobboerse_choice,
          p_ba_contact_consent => ${input.baContactConsent}::boolean,
          p_revision => ${input.revision}::integer) as result`);
      } catch (error) {
        return refused(c, error);
      }
      c.header("Cache-Control", "no-store");
      return c.json(await viewOf(result.access), 200);
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
        200: json(ProfilingView, "Saved; the profiling record, the assessment by presence"),
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
      try {
        await db.execute(sql`select write_profiling_assessment(
          p_participation_id => ${participationId}::uuid, p_context => ${context(c)},
          p_values => ${JSON.stringify(parsed.value)}::jsonb,
          p_revision => ${input.revision}::integer, p_key => ${fieldKey.key},
          p_key_id => ${fieldKey.keyId}) as result`);
      } catch (error) {
        return refused(c, error);
      }
      c.header("Cache-Control", "no-store");
      return c.json(await viewOf(result.access), 200);
    },
  );

  router.openapi(
    createRoute({
      method: "get",
      path: "/participations/{participationId}/profiling/unemployment",
      tags: ["participations"],
      summary:
        "The unemployment period decrypted (the assigned consultant, back office); the read is audited (sensitive_read)",
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
      let period: z.infer<typeof UnemploymentPeriodView>["period"];
      try {
        const { rows } = await db.execute<{
          result: { unemploymentPeriod: typeof period };
        }>(
          sql`select read_sensitive_fields(p_participation_id => ${participationId}::uuid,
            p_context => ${context(c, user)}, p_keys => ${textArray(["unemploymentPeriod"])}::text[],
            p_key => ${fieldKey.key}, p_key_id => ${fieldKey.keyId}) as result`,
        );
        period = rows[0]!.result.unemploymentPeriod;
      } catch (error) {
        if (functionRefusal(error) === "actor_not_allowed") return problem(c, "forbidden");
        throw error;
      }
      c.header("Cache-Control", "no-store");
      return c.json({ participationId, period }, 200);
    },
  );

  router.openapi(
    createRoute({
      method: "put",
      path: "/participations/{participationId}/profiling/unemployment",
      tags: ["participations"],
      summary:
        "Write the unemployment period, encrypted (the assigned consultant), or clear it; audited (sensitive_write)",
      middleware,
      request: {
        params: ParticipationParams,
        body: {
          required: true,
          content: { "application/json": { schema: UnemploymentPeriodInput } },
        },
      },
      responses: {
        200: json(ProfilingView, "Saved; the profiling record, the period by presence"),
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
      const { period } = c.req.valid("json");
      const result = await profilerAccess(c, participationId);
      if (!result.ok) return result.response as never;
      try {
        await db.execute(sql`select write_unemployment_period(
          p_participation_id => ${participationId}::uuid, p_context => ${context(c)},
          p_period => ${JSON.stringify(period)}::jsonb, p_key => ${fieldKey.key},
          p_key_id => ${fieldKey.keyId}) as result`);
      } catch (error) {
        return refused(c, error);
      }
      c.header("Cache-Control", "no-store");
      return c.json(await viewOf(result.access), 200);
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
