import { createRoute, z } from "@hono/zod-openapi";
import { and, desc, eq, participantReminder, participation, sql } from "@transfer/db";
import {
  mayReadReminders,
  ReminderPage,
  ReminderRequestInput,
  ReminderRequestResult,
} from "@transfer/domain";
import type { Context } from "hono";
import { projectAccess } from "../access";
import { createRouter, json, type AppEnv, type Deps } from "../context";
import { decodeCursor, encodeCursor } from "../cursor";
import { functionRefusal } from "../database-errors";
import { domainProblem, problem, problemResponses } from "../problem";
import { loadRelease } from "../projects/template-pins";
import { reminderRefusal, requestReminders } from "../reminders/service";
import { sendReminder } from "../reminders/send";
import { requireSession, sessionUser } from "../session";
import { utc } from "../sql";

// Reminders (data-protection.md, reminders; ADR-0010): the bulk request and the participant's
// message log. Ids, codes and dates only: never an address, a text or who requested by name.

const ProjectParams = z.object({ projectId: z.uuid() });
const ParticipationParams = z.object({ participationId: z.uuid() });
const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});

function unavailable(c: Context<AppEnv>, code: "jobs_unavailable" | "delivery_unavailable") {
  return problem(c, "service-unavailable", {
    errors: [{ pointer: "", code, detail: "Reminders can't be sent now" }],
  });
}

export function reminderRoutes(deps: Deps) {
  const { db, env, logger } = deps;
  const router = createRouter();
  const middleware = [requireSession(deps)];
  const release = loadRelease(env.configDir);
  const sendDeps = {
    db,
    logger,
    release,
    mailer: deps.mailer,
    smsSender: deps.smsSender,
    portalPublicUrl: env.portalPublicUrl!,
  };

  router.openapi(
    createRoute({
      method: "post",
      path: "/projects/{projectId}/reminders",
      tags: ["reminders"],
      summary:
        "Remind up to 500 participations of their open items (the PL or the assigned consultant); each is queued or skipped with a code",
      middleware,
      request: {
        params: ProjectParams,
        body: {
          required: true,
          content: { "application/json": { schema: ReminderRequestInput } },
        },
      },
      responses: {
        201: json(ReminderRequestResult, "The queued reminders and the skipped participations"),
        ...problemResponses(
          "validation-error",
          "unauthenticated",
          "forbidden",
          "not-found",
          "unsupported-media-type",
          "domain-error",
          "service-unavailable",
        ),
      },
    }),
    async (c) => {
      const user = sessionUser(c);
      const { projectId } = c.req.valid("param");
      const input = c.req.valid("json");
      const refusal = await reminderRefusal(db, user, projectId, input.participationIds);
      if (refusal?.kind === "not_found") return problem(c, "not-found");
      if (refusal?.kind === "hidden") {
        return domainProblem(
          c,
          refusal.indexes.map((index) => ({
            code: "participation_not_found",
            field: `participationIds/${index}`,
          })),
        );
      }
      if (refusal?.kind === "forbidden") return problem(c, "forbidden");
      if (refusal) return domainProblem(c, ["project_not_active"]);
      // Production never queues a reminder that can't go out (ADR-0006, ADR-0011).
      if (env.nodeEnv === "production") {
        if (!deps.reminders) return unavailable(c, "jobs_unavailable");
        if (!deps.mailer || !deps.smsSender) return unavailable(c, "delivery_unavailable");
      }
      let outcome: Awaited<ReturnType<typeof requestReminders>>;
      try {
        outcome = await requestReminders(
          { db, release, queue: deps.reminders },
          user,
          projectId,
          input,
          c.get("requestId"),
        );
      } catch (error) {
        // The database decides again: a change since the checks above.
        const code = functionRefusal(error);
        if (code === "actor_not_allowed") return problem(c, "forbidden");
        if (code === "participation_not_found" || code === "project_not_active") {
          return domainProblem(c, [code]);
        }
        throw error;
      }
      if (!deps.reminders) {
        // Without pg-boss (tests and e2e only) each job runs once after the commit.
        for (const reminderId of outcome.reminderIds) {
          deps.detached!.run("reminders.send", async () => {
            await sendReminder(sendDeps, reminderId, `detached:${reminderId}`, true);
          });
        }
      }
      return c.json(outcome.result, 201);
    },
  );

  router.openapi(
    createRoute({
      method: "get",
      path: "/participations/{participationId}/reminders",
      tags: ["reminders"],
      summary:
        "The participation's reminders, newest first (cursor); for whoever reads its case data",
      middleware,
      request: { params: ParticipationParams, query: PageQuery },
      responses: {
        200: json(ReminderPage, "A page of reminders"),
        ...problemResponses("validation-error", "unauthenticated", "forbidden", "not-found"),
      },
    }),
    async (c) => {
      const { participationId } = c.req.valid("param");
      const { limit, cursor } = c.req.valid("query");
      const [row] = await db
        .select({ projectId: participation.projectId })
        .from(participation)
        .where(eq(participation.id, participationId));
      if (!row) return problem(c, "not-found");
      const { subject, visible } = await projectAccess(db, sessionUser(c), row.projectId);
      if (!visible) return problem(c, "not-found");
      if (!mayReadReminders(subject, { projectId: row.projectId, participationId })) {
        return problem(c, "forbidden");
      }
      const after = cursor === undefined ? undefined : decodeCursor(cursor);
      if (cursor !== undefined && !after) {
        return problem(c, "validation-error", {
          errors: [{ parameter: "cursor", code: "invalid_cursor", detail: "Unknown cursor" }],
        });
      }
      const requestedAt = utc(participantReminder.requestedAt);
      const rows = await db
        .select({
          id: participantReminder.id,
          kind: participantReminder.kind,
          messageVersion: participantReminder.messageVersion,
          language: participantReminder.language,
          channel: participantReminder.channelKind,
          requestedAt,
          requestedOn: participantReminder.requestedOn,
          status: participantReminder.status,
          cancelReason: participantReminder.cancelReason,
          outcomeAt: utc(participantReminder.outcomeAt),
        })
        .from(participantReminder)
        .where(
          and(
            eq(participantReminder.participationId, participationId),
            after
              ? sql`(${participantReminder.requestedAt}, ${participantReminder.id})
                  < (${after.createdAt}::timestamptz, ${after.id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(desc(participantReminder.requestedAt), desc(participantReminder.id))
        .limit(limit + 1);
      const items = rows.slice(0, limit).map((item) => ({
        ...item,
        outcomeAt: item.outcomeAt ?? null,
      }));
      const last = items.at(-1);
      c.header("Cache-Control", "private, no-store");
      return c.json(
        {
          items,
          nextCursor:
            rows.length > limit && last
              ? encodeCursor({ createdAt: last.requestedAt, id: last.id })
              : null,
        },
        200,
      );
    },
  );

  return router;
}
