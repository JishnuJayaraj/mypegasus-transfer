import { createRoute, z } from "@hono/zod-openapi";
import { configDirs, loadOrganisation } from "@transfer/config/load";
import {
  activationCode,
  and,
  eq,
  inArray,
  participantDetails,
  participantIdentity,
  participation,
  sql,
  staffUser,
} from "@transfer/db";
import {
  ART14_NOTICE_VERSION,
  ActivationCodeActionInput,
  ActivationCodeRevocationInput,
  BatchActivationCodeInput,
  BatchActivationCodeResult,
  InPersonActivationCodeInput,
  ParticipationActivation,
  PrivacyNoticeBatchInput,
  PrivacyNoticeBatchResult,
  PrivacyNoticeInput,
  activationStatus,
  art14Notice,
  formatActivationCode,
  mayPerformOperation,
  normaliseEmail,
  normaliseMobile,
  type ActivationChannel,
  type ActivationDeliveryKind,
  type NoticeLanguage,
} from "@transfer/domain";
import { DeliveryOutcomeUnknown } from "@transfer/adapters";
import { randomUUID } from "node:crypto";
import type { Context } from "hono";
import { projectAccess, projectTarget } from "../access";
import {
  activationCodeKey,
  deliveryAddressKey,
  generateActivationCode,
  keyedHash,
} from "../activation/keys";
import { createRouter, json, type Deps } from "../context";
import { functionRefusal } from "../database-errors";
import { domainProblem, problem, problemResponses } from "../problem";
import { requireSession, sessionUser } from "../session";
import { auditContext, callFunction, utc } from "../sql";

const ProjectParams = z.object({ projectId: z.uuid() });
const ParticipationParams = z.object({ participationId: z.uuid() });
const EmptyResult = z.strictObject({});
const issuanceCodes = [
  "participation_not_found",
  "project_not_active",
  "participation_closed",
  "before_cutoff",
  "birth_date_required",
  "address_required",
  "identity_not_checked",
  "open_code_exists",
] as const;

function refusalIn(error: unknown, codes: readonly string[]) {
  const code = functionRefusal(error);
  if (code && codes.includes(code)) return code;
  throw error;
}

const asDomainProblem = (c: Context, code: string) => domainProblem(c, [code]);

const activationLink = (base: string, code: string) => {
  const url = new URL("activate", base.endsWith("/") ? base : `${base}/`);
  url.hash = code;
  return url.href;
};

const noticeLink = (base: string) =>
  new URL(`notice/art14/${ART14_NOTICE_VERSION}`, base.endsWith("/") ? base : `${base}/`).href;

export function activationRoutes(deps: Deps) {
  const { db } = deps;
  const router = createRouter();
  const middleware = [requireSession(deps)];
  const secret = deps.env.accessCodeSecret!;
  const codeKey = activationCodeKey(secret);
  const addressKey = deliveryAddressKey(secret);
  const portalUrl = deps.env.portalPublicUrl!;
  const organisation = loadOrganisation(configDirs(deps.env.configDir).organisation);

  async function accessTo(
    c: Context,
    participationId: string,
    kind:
      | "issueActivationCode"
      | "recordHandover"
      | "revokeActivationCode"
      | "providePrivacyNotice",
  ) {
    const [found] = await db
      .select({ projectId: participation.projectId })
      .from(participation)
      .where(eq(participation.id, participationId));
    if (!found) return "not-found" as const;
    const access = await projectAccess(db, sessionUser(c), found.projectId);
    if (!access.visible) return "not-found" as const;
    const allowed = mayPerformOperation(
      access.subject,
      { kind },
      projectTarget(found.projectId, access.regionId, participationId),
    ).ok;
    return allowed ? { found, access } : ("forbidden" as const);
  }

  async function codeBelongsTo(activationCodeId: string, participationId: string) {
    const [found] = await db
      .select({ id: activationCode.id })
      .from(activationCode)
      .where(
        and(
          eq(activationCode.id, activationCodeId),
          eq(activationCode.participationId, participationId),
        ),
      );
    return found !== undefined;
  }

  async function issue(
    executor: Pick<Deps["db"], "execute">,
    participationId: string,
    channel: ActivationChannel,
    language: NoticeLanguage,
    replaceOpenCode: boolean,
    actorId: string,
    requestId: string,
    delivery?: { kind: ActivationDeliveryKind; addressHash: string },
  ) {
    const id = randomUUID();
    const code = generateActivationCode();
    const hash = keyedHash(codeKey, code);
    const result = await executor.execute<{ expiresAt: string }>(
      sql`select to_char((issue_activation_code(p_participation_id => ${participationId}::uuid,
        p_code_hash => ${hash}, p_channel => ${channel}::activation_channel,
        p_language => ${language}::notice_language, p_notice_version => ${ART14_NOTICE_VERSION},
        p_replace_open_code => ${replaceOpenCode},
        p_delivery_kind => ${delivery?.kind ?? null}::activation_delivery_kind,
        p_delivery_address_hash => ${delivery?.addressHash ?? null},
        p_identity_checked => ${channel === "in_person"},
        p_context => ${auditContext(actorId, requestId)}, p_id => ${id}::uuid)).expires_at
        at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "expiresAt"`,
    );
    return { id, code, expiresAt: result.rows[0]!.expiresAt };
  }

  router.openapi(
    createRoute({
      method: "post",
      path: "/projects/{projectId}/activation-codes",
      tags: ["activation"],
      summary: "Issue and return printable letter or sheet activation codes, all or nothing",
      middleware,
      request: {
        params: ProjectParams,
        body: {
          required: true,
          content: { "application/json": { schema: BatchActivationCodeInput } },
        },
      },
      responses: {
        201: json(BatchActivationCodeResult, "New codes and print data; never retrievable later"),
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
      const input = c.req.valid("json");
      const access = await projectAccess(db, user, projectId);
      if (!access.visible) return problem(c, "not-found");
      if (
        !mayPerformOperation(
          access.subject,
          { kind: "issueActivationCode" },
          projectTarget(projectId, access.regionId),
        ).ok
      ) {
        return problem(c, "forbidden");
      }
      const rows = await db
        .select({ id: participation.id })
        .from(participation)
        .where(
          and(
            eq(participation.projectId, projectId),
            inArray(participation.id, input.participationIds),
          ),
        );
      if (rows.length !== input.participationIds.length) return problem(c, "not-found");
      try {
        const issued = await db.transaction(async (tx) => {
          const results = new Map<
            string,
            {
              made: Awaited<ReturnType<typeof issue>>;
              row: {
                p: typeof participation.$inferSelect;
                identity: typeof participantIdentity.$inferSelect | null;
                details: typeof participantDetails.$inferSelect | null;
              };
            }
          >();
          // A stable lock order avoids deadlocks between overlapping batches.
          for (const participationId of input.participationIds.toSorted()) {
            const made = await issue(
              tx,
              participationId,
              input.channel,
              input.language,
              input.replaceOpenCode,
              user.id,
              c.get("requestId"),
            );
            const [row] = await tx
              .select({
                p: participation,
                identity: participantIdentity,
                details: participantDetails,
              })
              .from(participation)
              .leftJoin(
                participantIdentity,
                eq(participantIdentity.participationId, participation.id),
              )
              .leftJoin(
                participantDetails,
                eq(participantDetails.participationId, participation.id),
              )
              .where(eq(participation.id, participationId));
            results.set(participationId, { made, row: row! });
          }
          return input.participationIds.map((participationId) => results.get(participationId)!);
        });
        const notice = art14Notice(input.language, organisation);
        c.header("Cache-Control", "no-store");
        return c.json(
          {
            items: issued.map(({ made, row }) => {
              return {
                activationCodeId: made.id,
                participationId: row.p.id,
                firstName: row.identity!.firstName,
                lastName: row.identity!.lastName,
                address: row.details?.addressStreet
                  ? {
                      street: row.details.addressStreet,
                      postalCode: row.details.addressPostalCode!,
                      city: row.details.addressCity!,
                      country: row.details.addressCountry!,
                    }
                  : null,
                code: formatActivationCode(made.code),
                activationUrl: activationLink(portalUrl, made.code),
                expiresAt: made.expiresAt,
                noticeVersion: ART14_NOTICE_VERSION,
                noticeLanguage: input.language,
                noticeTitle: notice.title,
                noticeText: notice.text,
              };
            }),
          },
          201,
        );
      } catch (error) {
        const refused = refusalIn(error, issuanceCodes);
        return refused === "participation_not_found"
          ? problem(c, "not-found")
          : asDomainProblem(c, refused);
      }
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/participations/{participationId}/activation-codes/in-person",
      tags: ["activation"],
      summary:
        "Record the photo-ID check, commit a pending code, then send it outside the transaction",
      middleware,
      request: {
        params: ParticipationParams,
        body: {
          required: true,
          content: { "application/json": { schema: InPersonActivationCodeInput } },
        },
      },
      responses: {
        201: json(ParticipationActivation, "Committed activation state; never the code or address"),
        ...problemResponses(
          "validation-error",
          "unauthenticated",
          "forbidden",
          "not-found",
          "domain-error",
          "service-unavailable",
        ),
      },
    }),
    async (c) => {
      const user = sessionUser(c);
      const { participationId } = c.req.valid("param");
      const input = c.req.valid("json");
      const checked = await accessTo(c, participationId, "issueActivationCode");
      if (typeof checked === "string") return problem(c, checked);
      const address =
        input.deliveryKind === "email"
          ? normaliseEmail(input.deliveryAddress)
          : normaliseMobile(input.deliveryAddress);
      if (!address)
        return domainProblem(c, [{ code: "channel_invalid", field: "deliveryAddress" }]);
      let made: Awaited<ReturnType<typeof issue>>;
      try {
        made = await issue(
          db,
          participationId,
          "in_person",
          input.language,
          input.replaceOpenCode,
          user.id,
          c.get("requestId"),
          {
            kind: input.deliveryKind,
            addressHash: keyedHash(addressKey, address),
          },
        );
      } catch (error) {
        const refused = refusalIn(error, issuanceCodes);
        return asDomainProblem(c, refused);
      }
      const link = activationLink(portalUrl, made.code);
      const durableNotice = noticeLink(portalUrl);
      const sent =
        input.deliveryKind === "email"
          ? deps.mailer!.send({
              to: address,
              subject:
                input.language === "de"
                  ? "Ihr persönlicher Aktivierungslink"
                  : "Your personal activation link",
              text: `${link}\n\n${durableNotice}`,
              idempotencyKey: made.id,
            })
          : deps.smsSender!.send({
              to: address,
              text: `${link}\n${durableNotice}`,
              idempotencyKey: made.id,
            });
      let outcome: "sent" | "failed" | "unknown";
      try {
        outcome = (await sent).status;
      } catch (error) {
        if (!(error instanceof DeliveryOutcomeUnknown)) throw error;
        outcome = "unknown";
      }
      await callFunction(
        db,
        sql`record_activation_delivery(
        p_activation_code_id => ${made.id}::uuid,
        p_outcome => ${outcome}::activation_delivery_status,
        p_context => ${auditContext(user.id, c.get("requestId"))})`,
      );
      if (outcome === "failed") {
        return problem(c, "service-unavailable", {
          errors: [
            { pointer: "", code: "delivery_failed", detail: "Delivery failed definitively" },
          ],
        });
      }
      const result = await activationOf(c, participationId);
      return typeof result === "string" ? problem(c, result) : c.json(result, 201);
    },
  );

  async function activationOf(c: Context, participationId: string) {
    const access = await accessTo(c, participationId, "issueActivationCode");
    if (typeof access === "string") return access;
    const [current] = await db
      .select({
        activationCodeId: activationCode.id,
        channel: activationCode.channel,
        deliveryKind: activationCode.deliveryKind,
        deliveryStatus: activationCode.deliveryStatus,
        noticeLanguage: activationCode.noticeLanguage,
        issuedBy: activationCode.issuedBy,
        issuedByDisplayName: staffUser.displayName,
        issuedAt: utc(activationCode.issuedAt),
        expiresAt: utc(activationCode.expiresAt),
        handedOverBy: activationCode.handedOverBy,
        handedOverAt: utc(activationCode.handedOverAt),
        identityCheckedBy: activationCode.identityCheckedBy,
        identityCheckedAt: utc(activationCode.identityCheckedAt),
        failedAttempts: activationCode.failedAttempts,
        revokedAt: utc(activationCode.revokedAt),
        revokeReason: activationCode.revokeReason,
        lockedAt: utc(activationCode.lockedAt),
        usedAt: utc(activationCode.usedAt),
      })
      .from(activationCode)
      .innerJoin(staffUser, eq(staffUser.id, activationCode.issuedBy))
      .where(eq(activationCode.participationId, participationId))
      .orderBy(sql`${activationCode.issuedAt} desc`)
      .limit(1);
    const target = projectTarget(access.found.projectId, access.access.regionId, participationId);
    const may = (
      kind:
        | "issueActivationCode"
        | "recordHandover"
        | "revokeActivationCode"
        | "providePrivacyNotice",
    ) => mayPerformOperation(access.access.subject, { kind }, target).ok;
    const snapshot = current
      ? {
          channel: current.channel,
          issuedAt: current.issuedAt,
          expiresAt: current.expiresAt,
          deliveryStatus: current.deliveryStatus,
          handedOverAt: current.handedOverAt,
          lockedAt: current.lockedAt,
          revokedAt: current.revokedAt,
          usedAt: current.usedAt,
        }
      : null;
    return {
      status: activationStatus(false, snapshot, deps.clock.now().toISOString()),
      current: current
        ? {
            ...current,
            attemptsLeft: 5 - current.failedAttempts,
          }
        : null,
      capabilities: {
        issueActivationCode: may("issueActivationCode"),
        recordHandover: may("recordHandover"),
        revokeActivationCode: may("revokeActivationCode"),
        providePrivacyNotice: may("providePrivacyNotice"),
      },
    };
  }

  router.openapi(
    createRoute({
      method: "get",
      path: "/participations/{participationId}/activation",
      tags: ["activation"],
      summary: "Activation state and capabilities without any code, destination or hash",
      middleware,
      request: { params: ParticipationParams },
      responses: {
        200: json(ParticipationActivation, "Activation state"),
        ...problemResponses("validation-error", "unauthenticated", "forbidden", "not-found"),
      },
    }),
    async (c) => {
      const result = await activationOf(c, c.req.valid("param").participationId);
      return typeof result === "string" ? problem(c, result) : c.json(result, 200);
    },
  );

  for (const action of [
    {
      path: "/participations/{participationId}/activation-codes/handover",
      kind: "recordHandover" as const,
      fn: "hand_over_activation_code",
    },
  ]) {
    router.openapi(
      createRoute({
        method: "post",
        path: action.path,
        tags: ["activation"],
        summary: "Record sheet handover after inspecting an original official photo ID",
        middleware,
        request: {
          params: ParticipationParams,
          body: {
            required: true,
            content: { "application/json": { schema: ActivationCodeActionInput } },
          },
        },
        responses: {
          200: json(ParticipationActivation, "Updated activation state"),
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
        const { participationId } = c.req.valid("param");
        const checked = await accessTo(c, participationId, action.kind);
        if (typeof checked === "string") return problem(c, checked);
        const { activationCodeId } = c.req.valid("json");
        if (!(await codeBelongsTo(activationCodeId, participationId))) {
          return problem(c, "not-found");
        }
        try {
          await callFunction(
            db,
            sql`hand_over_activation_code(
            p_activation_code_id => ${activationCodeId}::uuid,
            p_context => ${auditContext(sessionUser(c).id, c.get("requestId"))})`,
          );
        } catch (error) {
          const refused = refusalIn(error, ["activation_code_not_found", "handover_not_allowed"]);
          return refused === "activation_code_not_found"
            ? problem(c, "not-found")
            : asDomainProblem(c, refused);
        }
        const result = await activationOf(c, participationId);
        return typeof result === "string" ? problem(c, result) : c.json(result, 200);
      },
    );
  }

  router.openapi(
    createRoute({
      method: "post",
      path: "/participations/{participationId}/activation-codes/revocation",
      tags: ["activation"],
      summary: "Revoke an open code as lost or an unhanded sheet",
      middleware,
      request: {
        params: ParticipationParams,
        body: {
          required: true,
          content: { "application/json": { schema: ActivationCodeRevocationInput } },
        },
      },
      responses: {
        200: json(ParticipationActivation, "Updated activation state"),
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
      const { participationId } = c.req.valid("param");
      const checked = await accessTo(c, participationId, "revokeActivationCode");
      if (typeof checked === "string") return problem(c, checked);
      const input = c.req.valid("json");
      if (!(await codeBelongsTo(input.activationCodeId, participationId))) {
        return problem(c, "not-found");
      }
      try {
        await callFunction(
          db,
          sql`revoke_activation_code(
          p_activation_code_id => ${input.activationCodeId}::uuid,
          p_reason => ${input.reason}::activation_revoke_reason,
          p_context => ${auditContext(sessionUser(c).id, c.get("requestId"))})`,
        );
      } catch (error) {
        const refused = refusalIn(error, [
          "activation_code_not_found",
          "activation_code_not_open",
          "handover_not_allowed",
        ]);
        return refused === "activation_code_not_found"
          ? problem(c, "not-found")
          : asDomainProblem(c, refused);
      }
      const result = await activationOf(c, participationId);
      return typeof result === "string" ? problem(c, result) : c.json(result, 200);
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/projects/{projectId}/privacy-notices",
      tags: ["privacy notices"],
      summary: "Record and return notice-only letters, all or nothing",
      middleware,
      request: {
        params: ProjectParams,
        body: {
          required: true,
          content: { "application/json": { schema: PrivacyNoticeBatchInput } },
        },
      },
      responses: {
        201: json(PrivacyNoticeBatchResult, "Notice-only letter print data"),
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
      const input = c.req.valid("json");
      const access = await projectAccess(db, user, projectId);
      if (!access.visible) return problem(c, "not-found");
      if (
        !mayPerformOperation(
          access.subject,
          { kind: "providePrivacyNotice" },
          projectTarget(projectId, access.regionId),
        ).ok
      )
        return problem(c, "forbidden");
      const rows = await db
        .select({ id: participation.id })
        .from(participation)
        .where(
          and(
            eq(participation.projectId, projectId),
            inArray(participation.id, input.participationIds),
          ),
        );
      if (rows.length !== input.participationIds.length) return problem(c, "not-found");
      let printRows;
      try {
        printRows = await db.transaction(async (tx) => {
          for (const participationId of input.participationIds.toSorted()) {
            await callFunction(
              tx,
              sql`record_privacy_notice(p_participation_id => ${participationId}::uuid,
            p_language => ${input.language}::notice_language, p_method => 'letter'::notice_method,
            p_notice_version => ${ART14_NOTICE_VERSION},
            p_context => ${auditContext(user.id, c.get("requestId"))})`,
            );
          }
          const current = await tx
            .select({
              p: participation,
              identity: participantIdentity,
              details: participantDetails,
            })
            .from(participation)
            .leftJoin(
              participantIdentity,
              eq(participantIdentity.participationId, participation.id),
            )
            .leftJoin(participantDetails, eq(participantDetails.participationId, participation.id))
            .where(inArray(participation.id, input.participationIds));
          const byId = new Map(current.map((row) => [row.p.id, row]));
          return input.participationIds.map((id) => byId.get(id)!);
        });
      } catch (error) {
        const refused = refusalIn(error, ["participation_not_found", "address_required"]);
        return refused === "participation_not_found"
          ? problem(c, "not-found")
          : asDomainProblem(c, refused);
      }
      const notice = art14Notice(input.language, organisation);
      c.header("Cache-Control", "no-store");
      return c.json(
        {
          items: printRows.map(({ p, identity, details }) => ({
            participationId: p.id,
            firstName: identity!.firstName,
            lastName: identity!.lastName,
            address: {
              street: details!.addressStreet!,
              postalCode: details!.addressPostalCode!,
              city: details!.addressCity!,
              country: details!.addressCountry!,
            },
            noticeVersion: ART14_NOTICE_VERSION,
            noticeLanguage: input.language,
            noticeTitle: notice.title,
            noticeText: notice.text,
          })),
        },
        201,
      );
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/participations/{participationId}/privacy-notices",
      tags: ["privacy notices"],
      summary: "Record an Art. 14 notice handed over in person",
      middleware,
      request: {
        params: ParticipationParams,
        body: { required: true, content: { "application/json": { schema: PrivacyNoticeInput } } },
      },
      responses: {
        201: json(EmptyResult, "Notice recorded"),
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
      const { participationId } = c.req.valid("param");
      const checked = await accessTo(c, participationId, "providePrivacyNotice");
      if (typeof checked === "string") return problem(c, checked);
      const input = c.req.valid("json");
      await callFunction(
        db,
        sql`record_privacy_notice(p_participation_id => ${participationId}::uuid,
        p_language => ${input.language}::notice_language, p_method => ${input.method}::notice_method,
        p_notice_version => ${ART14_NOTICE_VERSION},
        p_context => ${auditContext(sessionUser(c).id, c.get("requestId"))})`,
      );
      return c.json({}, 201);
    },
  );

  return router;
}
