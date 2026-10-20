import { createRoute, z } from "@hono/zod-openapi";
import {
  and,
  asc,
  eq,
  inArray,
  baReportingTask,
  participantDetails,
  participationDsvAmendment,
  participantIdentity,
  participation,
  project,
  projectEntryWave,
  sql,
} from "@transfer/db";
import {
  AssignEntryWaveInput,
  entryWaveAssignment,
  ManualParticipationInput,
  ParticipationDatesInput,
  mayListField,
  mayPerformOperation,
  PageQuery,
  participationDatesCapability,
  participationDetail,
  ParticipationDetail,
  participationListScope,
  ParticipationPage,
  type ParticipationListItem,
  type StaffUser,
} from "@transfer/domain";
import type { Context } from "hono";
import { projectAccess } from "../access";
import { createRouter, json, type Deps } from "../context";
import { decodeCursor, encodeCursor } from "../cursor";
import { ImportRefusal } from "../imports/analysis";
import { createManually, ManualCreationRefusal } from "../participations/manual-creation";
import {
  createStatusService,
  DatesRefusal,
  lifecycleRunCompleted,
  StatusServiceError,
} from "../participations/status-service";
import { loadRelease } from "../projects/template-pins";
import { domainProblem, problem, problemResponses } from "../problem";
import { requireSession, sessionUser } from "../session";
import { utc } from "../sql";

const ProjectParams = z.object({ projectId: z.uuid() });
const ParticipationParams = z.object({ participationId: z.uuid() });
const personFields = ["personnelNumber", "lastName", "firstName"] as const;

const waveColumns = {
  id: projectEntryWave.id,
  code: projectEntryWave.code,
  name: projectEntryWave.name,
  signingDeadline: projectEntryWave.signingDeadline,
  defaultTgStart: projectEntryWave.defaultTgStart,
  defaultTgEnd: projectEntryWave.defaultTgEnd,
  latestEntryDate: projectEntryWave.latestEntryDate,
};

/** A status service refusal as its problem (R21): codes only, never a value. */
function refusal(c: Context, error: unknown) {
  if (!(error instanceof StatusServiceError)) throw error;
  if (error.kind === "not_found") return problem(c, "not-found");
  if (error.kind === "forbidden") return problem(c, "forbidden");
  if (error.kind === "stale") {
    return problem(c, "conflict", {
      errors: [{ pointer: "", code: error.code, detail: "The participation changed meanwhile" }],
    });
  }
  return domainProblem(c, [error.code]);
}

export function participationRoutes(deps: Deps) {
  const { db, clock } = deps;
  const router = createRouter();
  const middleware = [requireSession(deps)];
  const statusService = createStatusService({ db, clock });
  const release = loadRelease(deps.env.configDir);

  /**
   * One participation for the user (R29–R31): undefined when it doesn't exist or its project is
   * hidden from them (both a 404, so its existence isn't revealed), null when they may read none
   * of its case data (a 403).
   */
  async function detailOf(user: StaffUser, participationId: string) {
    const [row] = await db
      .select({
        p: participation,
        projectType: project.type,
        wave: waveColumns,
        identity: participantIdentity,
        details: participantDetails,
      })
      .from(participation)
      .innerJoin(project, eq(project.id, participation.projectId))
      .leftJoin(projectEntryWave, eq(projectEntryWave.id, participation.entryWaveId))
      .leftJoin(participantIdentity, eq(participantIdentity.participationId, participation.id))
      .leftJoin(participantDetails, eq(participantDetails.participationId, participation.id))
      .where(eq(participation.id, participationId));
    if (!row) return undefined;
    const { p, identity, details } = row;
    const { subject, visible } = await projectAccess(db, user, p.projectId);
    if (!visible) return undefined;
    const wave = row.wave?.id ? row.wave : null;
    const dates = { tgStart: p.tgStart, tgEnd: p.tgEnd, offerDeadline: p.offerDeadline };
    const today = clock.today();
    // The wave choice is offered when the PL may assign one and some other wave of the project
    // passes the domain rule; otherwise the reason, permission first (R31, round 26).
    const target = { projectId: p.projectId, regionId: null, participationId };
    const permitted = (kind: "assignEntryWave" | "setParticipationDates") =>
      mayPerformOperation(subject, { kind }, target).ok;
    const waves = await db
      .select({ id: projectEntryWave.id })
      .from(projectEntryWave)
      .where(eq(projectEntryWave.projectId, p.projectId));
    const assignment = entryWaveAssignment(
      {
        projectType: row.projectType,
        current: { status: p.status, profilingStatus: p.profilingStatus, dsvStatus: p.dsvStatus },
        actor: { type: "user", staffUserId: user.id },
        today,
        now: clock.now(),
        wave,
        participation: dates,
      },
      p.projectId,
      waves.map(({ id }) => id),
      permitted("assignEntryWave"),
    );
    const datesChange = participationDatesCapability(
      { projectType: row.projectType, status: p.status, dsvStatus: p.dsvStatus, wave },
      permitted("setParticipationDates"),
    );
    const amendments = await db
      .select({
        id: participationDsvAmendment.id,
        kind: participationDsvAmendment.kind,
        fullyExecutedOn: participationDsvAmendment.fullyExecutedOn,
        oldTgStart: participationDsvAmendment.oldTgStart,
        newTgStart: participationDsvAmendment.newTgStart,
        oldTgEnd: participationDsvAmendment.oldTgEnd,
        newTgEnd: participationDsvAmendment.newTgEnd,
        confirmedBy: participationDsvAmendment.confirmedBy,
        confirmedAt: utc(participationDsvAmendment.confirmedAt),
        originalLocation: participationDsvAmendment.originalLocation,
        documentReference: participationDsvAmendment.documentReference,
      })
      .from(participationDsvAmendment)
      .where(eq(participationDsvAmendment.participationId, participationId))
      .orderBy(asc(participationDsvAmendment.confirmedAt));
    const baReportingTasks = await db
      .select({
        id: baReportingTask.id,
        reportingKind: baReportingTask.reportingKind,
        subjectDate: baReportingTask.subjectDate,
        status: baReportingTask.status,
        createdAt: utc(baReportingTask.createdAt),
        reportedOn: baReportingTask.reportedOn,
      })
      .from(baReportingTask)
      .where(eq(baReportingTask.participationId, participationId))
      .orderBy(asc(baReportingTask.createdAt), asc(baReportingTask.reportingKind));
    return participationDetail(
      subject,
      {
        amendments,
        baReportingTasks,
        id: p.id,
        projectId: p.projectId,
        status: p.status,
        profilingStatus: p.profilingStatus,
        dsvStatus: p.dsvStatus,
        statusVersion: p.statusVersion,
        wave,
        dates: {
          ...dates,
          tgEntryDate: p.tgEntryDate,
          exitDate: p.exitDate,
          withdrawnOn: p.withdrawnOn,
          profilingDoneOn: p.profilingDoneOn,
        },
        person: {
          personnelNumber: identity?.personnelNumber ?? null,
          lastName: identity?.lastName ?? null,
          firstName: identity?.firstName ?? null,
          birthDate: identity?.birthDate ?? null,
          oldEmploymentEndDate: details?.oldEmploymentEndDate ?? null,
          // All four parts or none (round 32, a table CHECK).
          address:
            details?.addressStreet != null
              ? {
                  street: details.addressStreet,
                  postalCode: details.addressPostalCode!,
                  city: details.addressCity!,
                  country: details.addressCountry!,
                }
              : null,
          phone: details?.phone ?? null,
          mobile: details?.mobile ?? null,
          privateEmail: details?.privateEmail ?? null,
          workEmail: details?.workEmail ?? null,
        },
      },
      {
        today,
        entryRunCompletedToday: await lifecycleRunCompleted(db, today),
        capabilities: {
          assignEntryWave: assignment.allowed,
          setParticipationDates: datesChange.allowed,
        },
        refusals: {
          assignEntryWave: assignment.refusal,
          setParticipationDates: datesChange.refusal,
        },
      },
    );
  }

  router.openapi(
    createRoute({
      method: "get",
      path: "/projects/{projectId}/participations",
      tags: ["participations"],
      summary:
        "The project's participations in creation order (cursor pagination), with the person fields the viewer may list",
      middleware,
      request: { params: ProjectParams, query: PageQuery },
      responses: {
        200: json(ParticipationPage, "A page of participations"),
        ...problemResponses("validation-error", "unauthenticated", "forbidden", "not-found"),
      },
    }),
    async (c) => {
      const { projectId } = c.req.valid("param");
      const { limit, cursor: rawCursor } = c.req.valid("query");
      const cursor = rawCursor === undefined ? undefined : decodeCursor(rawCursor);
      if (rawCursor !== undefined && !cursor) {
        return problem(c, "validation-error", {
          errors: [{ parameter: "cursor", code: "invalid_cursor", detail: "Malformed cursor" }],
        });
      }
      const { subject, visible } = await projectAccess(db, sessionUser(c), projectId);
      if (!visible) return problem(c, "not-found");
      // R29: the PL and back office list every participation, an assigned consultant exactly
      // theirs; a viewer who may list none (an unassigned consultant, an org role) gets a 403.
      // The per-row decision below stays.
      const scope = participationListScope(subject, projectId);
      if (scope.kind === "none") return problem(c, "forbidden");
      const rows = await db
        .select({
          id: participation.id,
          createdAt: utc(participation.createdAt),
          status: participation.status,
          profilingStatus: participation.profilingStatus,
          dsvStatus: participation.dsvStatus,
          entryWaveId: participation.entryWaveId,
          personnelNumber: participantIdentity.personnelNumber,
          lastName: participantIdentity.lastName,
          firstName: participantIdentity.firstName,
        })
        .from(participation)
        .leftJoin(participantIdentity, eq(participantIdentity.participationId, participation.id))
        .where(
          and(
            eq(participation.projectId, projectId),
            scope.kind === "assigned"
              ? inArray(participation.id, [...scope.participationIds])
              : undefined,
            cursor &&
              sql`(${participation.createdAt}, ${participation.id}) > (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`,
          ),
        )
        .orderBy(asc(participation.createdAt), asc(participation.id))
        .limit(limit + 1);
      const last = rows.slice(0, limit).at(-1);
      const items = rows
        .slice(0, limit)
        .map(({ createdAt: _createdAt, ...row }): ParticipationListItem => {
          const item: ParticipationListItem = {
            id: row.id,
            status: row.status,
            profilingStatus: row.profilingStatus,
            dsvStatus: row.dsvStatus,
            entryWaveId: row.entryWaveId,
          };
          for (const field of personFields) {
            const value = row[field];
            if (value !== null && mayListField(subject, projectId, row.id, field)) {
              item[field] = value;
            }
          }
          return item;
        });
      const nextCursor =
        rows.length > limit && last
          ? encodeCursor({ createdAt: last.createdAt, id: last.id })
          : null;
      return c.json({ items, nextCursor }, 200);
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/projects/{projectId}/participations",
      tags: ["participations"],
      summary:
        "Create one participation by hand, through the import's rules (the PL); returns the participation",
      middleware,
      request: {
        params: ProjectParams,
        body: {
          required: true,
          content: { "application/json": { schema: ManualParticipationInput } },
        },
      },
      responses: {
        201: json(ParticipationDetail, "The new participation"),
        ...problemResponses(
          "validation-error",
          "unauthenticated",
          "forbidden",
          "not-found",
          "domain-error",
        ),
      },
    }),
    async (c) => {
      const user = sessionUser(c);
      const { projectId } = c.req.valid("param");
      // Visibility (404) and the PL's permission (403) first, like the import (R32).
      const { subject, visible } = await projectAccess(db, user, projectId);
      if (!visible) return problem(c, "not-found");
      const target = { projectId, regionId: null, participationId: null };
      if (!mayPerformOperation(subject, { kind: "importParticipations" }, target).ok) {
        return problem(c, "forbidden");
      }
      const actor = { staffUserId: user.id, requestId: c.get("requestId") as string, subject };
      let participationId: string;
      try {
        participationId = await createManually(
          { db, release, clock },
          actor,
          projectId,
          c.req.valid("json"),
        );
      } catch (error) {
        if (error instanceof ManualCreationRefusal) {
          return problem(c, "domain-error", {
            errors: error.issues.map((issue) => ({
              pointer: issue.target ? `/values/${issue.target}` : "",
              code: issue.code,
              detail: "Refused by a domain rule",
            })),
            ...(error.participationId && { participationId: error.participationId }),
          });
        }
        if (error instanceof ImportRefusal) {
          if (error.kind === "not_found") return problem(c, "not-found");
          return domainProblem(c, error.issues);
        }
        if (error instanceof StatusServiceError && error.kind === "forbidden") {
          return problem(c, "forbidden");
        }
        throw error;
      }
      return c.json((await detailOf(user, participationId))!, 201);
    },
  );

  router.openapi(
    createRoute({
      method: "get",
      path: "/participations/{participationId}",
      tags: ["participations"],
      summary:
        "One participation: statuses, wave, contractual dates and the person fields the viewer may read",
      middleware,
      request: { params: ParticipationParams },
      responses: {
        200: json(ParticipationDetail, "The participation"),
        ...problemResponses("validation-error", "unauthenticated", "forbidden", "not-found"),
      },
    }),
    async (c) => {
      const detail = await detailOf(sessionUser(c), c.req.valid("param").participationId);
      if (detail === undefined) return problem(c, "not-found");
      if (detail === null) return problem(c, "forbidden");
      return c.json(detail, 200);
    },
  );

  router.openapi(
    createRoute({
      method: "put",
      path: "/participations/{participationId}/entry-wave",
      tags: ["participations"],
      summary:
        "Assign the participation's entry wave (the PL, before the first offer); returns the participation",
      middleware,
      request: {
        params: ParticipationParams,
        body: { required: true, content: { "application/json": { schema: AssignEntryWaveInput } } },
      },
      responses: {
        200: json(ParticipationDetail, "The participation with its new wave"),
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
      const user = sessionUser(c);
      const { participationId } = c.req.valid("param");
      // Visibility first, so a hidden participation is a 404 whatever the body says.
      const [found] = await db
        .select({ projectId: participation.projectId })
        .from(participation)
        .where(eq(participation.id, participationId));
      const access = found && (await projectAccess(db, user, found.projectId));
      if (!access?.visible) return problem(c, "not-found");
      const { subject } = access;
      try {
        await statusService.assignEntryWave(
          subject,
          { participationId, waveId: c.req.valid("json").waveId },
          { requestId: c.get("requestId") },
        );
      } catch (error) {
        return refusal(c, error);
      }
      const detail = await detailOf(user, participationId);
      return detail ? c.json(detail, 200) : problem(c, "forbidden");
    },
  );

  router.openapi(
    createRoute({
      method: "put",
      path: "/participations/{participationId}/dates",
      tags: ["participations"],
      summary:
        "Change the participation's contractual TG dates (the PL), with the DSV amendment once it is signed; returns the participation",
      middleware,
      request: {
        params: ParticipationParams,
        body: {
          required: true,
          content: { "application/json": { schema: ParticipationDatesInput } },
        },
      },
      responses: {
        200: json(ParticipationDetail, "The participation with its new dates and tasks"),
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
      const user = sessionUser(c);
      const { participationId } = c.req.valid("param");
      // Visibility first, so a hidden participation is a 404 whatever the body says.
      const [found] = await db
        .select({ projectId: participation.projectId })
        .from(participation)
        .where(eq(participation.id, participationId));
      const access = found && (await projectAccess(db, user, found.projectId));
      if (!access?.visible) return problem(c, "not-found");
      try {
        await statusService.setParticipationDates(
          access.subject,
          { participationId, ...c.req.valid("json") },
          { requestId: c.get("requestId") },
        );
      } catch (error) {
        if (error instanceof DatesRefusal) return domainProblem(c, error.issues);
        return refusal(c, error);
      }
      const detail = await detailOf(user, participationId);
      return detail ? c.json(detail, 200) : problem(c, "forbidden");
    },
  );

  return router;
}
