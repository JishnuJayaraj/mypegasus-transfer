import { createRoute, z } from "@hono/zod-openapi";
import { sql, transactionWithClient } from "@transfer/db";
import {
  ART14_NOTICE_VERSION,
  ActivationBirthDateInput,
  ActivationChannelInput,
  ActivationCodeInput,
  ActivationCompletionInput,
  ActivationDeliveryAddressInput,
  ActivationState,
  PORTAL_CONTACT_CONSENT_VERSION,
  PortalMe,
  maskContactAddress,
  nextActivationStep,
  normaliseActivationCode,
  normaliseContact,
  portalLimits,
  type ActivationChannel,
  type ContactKind,
  type NoticeLanguage,
} from "@transfer/domain";
import type { Context } from "hono";
import { randomInt, randomUUID } from "node:crypto";
import {
  activationCodeKey,
  deliveryAddressKey,
  keyedHash,
  oneTimeCodeKey,
} from "../activation/keys";
import { createRouter, json, type AppEnv, type Deps } from "../context";
import { functionRefusal } from "../database-errors";
import { domainProblem, problem, problemResponses } from "../problem";
import {
  clearPortalCookie,
  newPortalToken,
  portalSession,
  portalTokenHash,
  requirePortalSession,
  setPortalCookie,
} from "../portal-session";
import { clientIp, createThrottle } from "../throttle";

// The participant's activation (Slice 3 plan, PR 3e; D21–D29). Codes, one-time codes and
// addresses arrive only in bodies and leave only as keyed hashes for the functions; no response,
// log line or audit row carries them. Every code submission passes the per-IP throttle (D14).

const NoContent = { 204: { description: "Done" } };
const ACTIVATED = "activated";

/** The refusals of the activation functions the portal answers with their code (422). */
const domainRefusals = new Set([
  "code_invalid",
  "before_cutoff",
  "step_not_allowed",
  "channel_in_use",
  "channel_invalid",
]);

function minutes(value: number) {
  return value * 60_000;
}

function oneTimeCodeMessage(language: NoticeLanguage, code: string) {
  return language === "de"
    ? {
        subject: "Ihr Bestätigungscode für das Teilnehmerportal",
        text: `Ihr Bestätigungscode lautet ${code}. Er gilt ${portalLimits.oneTimeCode.validityMinutes} Minuten. Geben Sie ihn niemandem weiter.`,
      }
    : {
        subject: "Your confirmation code for the participant portal",
        text: `Your confirmation code is ${code}. It is valid for ${portalLimits.oneTimeCode.validityMinutes} minutes. Do not share it with anyone.`,
      };
}

export function portalRoutes(deps: Deps) {
  const { db, env } = deps;
  const router = createRouter();
  const secret = env.accessCodeSecret!;
  const codeKey = activationCodeKey(secret);
  const addressKey = deliveryAddressKey(secret);
  const otpKey = oneTimeCodeKey(secret);
  const throttle = createThrottle({
    limit: portalLimits.ipThrottle.submissions,
    windowMs: minutes(portalLimits.ipThrottle.windowMinutes),
    clock: deps.clock,
  });
  const activating = [requirePortalSession(deps, "activating")];
  const active = [requirePortalSession(deps, "active")];

  /** 429 `rate_limited` when the client's IP has used up its submissions. */
  function throttled(c: Context<AppEnv>) {
    const taken = throttle.take(clientIp(c));
    if (taken.ok) return undefined;
    c.header("Retry-After", String(taken.retryAfterSeconds));
    return problem(c, "too-many-requests", {
      errors: [{ pointer: "", code: "rate_limited", detail: "Please try again later" }],
    });
  }

  /** A refusal of a function: 401 for a dead session, 422 with its code, or rethrown. */
  function refused(c: Context<AppEnv>, error: unknown) {
    const code = functionRefusal(error);
    if (code === "session_invalid") return problem(c, "unauthenticated");
    if (code === "rate_limited") {
      c.header("Retry-After", "3600");
      return problem(c, "too-many-requests", {
        errors: [{ pointer: "", code, detail: "Please try again later" }],
      });
    }
    if (code === "code_invalid") clearPortalCookie(c, env);
    if (code && domainRefusals.has(code)) return domainProblem(c, [code]);
    throw error;
  }

  /** The generic answer to any code that can't be used (D14), which ends the browser's session. */
  function codeInvalid(c: Context<AppEnv>) {
    clearPortalCookie(c, env);
    return domainProblem(c, [{ code: "code_invalid", field: null }]);
  }

  /** Where the session's activation stands (D23), from its code and the steps it recorded. */
  async function stateOf(tokenHash: string): Promise<ActivationState> {
    const { rows } = await db.execute<{
      channel: ActivationChannel;
      deliveryKind: ContactKind | null;
      language: NoticeLanguage;
      hasBirthDate: boolean;
      birthDateChecked: boolean;
      deliveryAddressChecked: boolean;
      oneTimeCodeSent: boolean;
    }>(sql`
      select c.channel, c.delivery_kind as "deliveryKind", c.notice_language as language,
        exists (select from participant_identity i
                where i.participation_id = s.participation_id and i.birth_date is not null)
          as "hasBirthDate",
        s.birth_date_checked_at is not null as "birthDateChecked",
        s.delivery_address_checked_at is not null as "deliveryAddressChecked",
        exists (select from one_time_code_challenge ch
                where ch.participation_id = s.participation_id
                  and ch.purpose = 'channel_verification' and ch.consumed_at is null
                  and ch.invalidated_at is null and ch.expires_at > now()
                  and ch.failed_attempts < ${portalLimits.oneTimeCode.failures})
          as "oneTimeCodeSent"
      from participant_session s join activation_code c on c.id = s.activation_code_id
      where s.token_hash = ${tokenHash}`);
    const { channel, deliveryKind, language, ...progress } = rows[0]!;
    return {
      nextStep: nextActivationStep({ channel, ...progress }),
      channel,
      deliveryKind,
      language,
      noticeVersion: ART14_NOTICE_VERSION,
      consentVersion: PORTAL_CONTACT_CONSENT_VERSION,
    };
  }

  router.openapi(
    createRoute({
      method: "post",
      path: "/portal/activation",
      tags: ["portal"],
      summary: "Start an activation with a personal code; sets the portal session cookie",
      request: {
        body: { required: true, content: { "application/json": { schema: ActivationCodeInput } } },
      },
      responses: {
        200: json(ActivationState, "The activating session's next step"),
        ...problemResponses(
          "validation-error",
          "unauthenticated",
          "domain-error",
          "too-many-requests",
        ),
      },
    }),
    async (c) => {
      const limited = throttled(c);
      if (limited) return limited;
      const code = normaliseActivationCode(c.req.valid("json").code);
      // A malformed code counts nothing on any code (D14): the generic answer.
      if (!code) return codeInvalid(c);
      const { token, tokenHash } = newPortalToken();
      let started: unknown;
      try {
        const { rows } = await db.execute<{ result: unknown }>(sql`
          select start_activation(${keyedHash(codeKey, code)}, ${tokenHash},
            ${c.get("requestId")}) as result`);
        started = rows[0]!.result;
      } catch (error) {
        return refused(c, error);
      }
      if (started === null) return codeInvalid(c);
      setPortalCookie(c, env, token);
      c.header("Cache-Control", "no-store");
      return c.json(await stateOf(tokenHash), 200);
    },
  );

  /** Runs a knowledge check; `mismatch` and `locked` are its counted failures (D14). */
  async function knowledgeCheck(c: Context<AppEnv>, query: ReturnType<typeof sql>) {
    const { tokenHash } = portalSession(c);
    let result: string;
    try {
      const { rows } = await db.execute<{ result: string }>(sql`select ${query} as result`);
      result = rows[0]!.result;
    } catch (error) {
      return refused(c, error);
    }
    if (result === "locked") return codeInvalid(c);
    if (result === "mismatch") return domainProblem(c, ["knowledge_check_failed"]);
    return c.json(await stateOf(tokenHash), 200);
  }

  router.openapi(
    createRoute({
      method: "post",
      path: "/portal/activation/birth-date",
      tags: ["portal"],
      summary: "The birth-date step; a wrong date counts on the code, the fifth locks it",
      middleware: activating,
      request: {
        body: {
          required: true,
          content: { "application/json": { schema: ActivationBirthDateInput } },
        },
      },
      responses: {
        200: json(ActivationState, "The next step"),
        ...problemResponses(
          "validation-error",
          "unauthenticated",
          "domain-error",
          "too-many-requests",
        ),
      },
    }),
    async (c) => {
      const limited = throttled(c);
      if (limited) return limited;
      const { birthDate } = c.req.valid("json");
      return knowledgeCheck(
        c,
        sql`check_activation_birth_date(${portalSession(c).tokenHash}, ${birthDate}::date,
          ${c.get("requestId")})`,
      );
    },
  );

  /** The kind an in-person code's link went to. */
  async function deliveryKindOf(tokenHash: string) {
    const { rows } = await db.execute<{ kind: ContactKind | null }>(sql`
      select c.delivery_kind as kind from participant_session s
      join activation_code c on c.id = s.activation_code_id where s.token_hash = ${tokenHash}`);
    return rows[0]?.kind ?? null;
  }

  router.openapi(
    createRoute({
      method: "post",
      path: "/portal/activation/delivery-address",
      tags: ["portal"],
      summary: "For an in-person code, the email or mobile the link came to, retyped",
      middleware: activating,
      request: {
        body: {
          required: true,
          content: { "application/json": { schema: ActivationDeliveryAddressInput } },
        },
      },
      responses: {
        200: json(ActivationState, "The next step"),
        ...problemResponses(
          "validation-error",
          "unauthenticated",
          "domain-error",
          "too-many-requests",
        ),
      },
    }),
    async (c) => {
      const limited = throttled(c);
      if (limited) return limited;
      const { tokenHash } = portalSession(c);
      const kind = await deliveryKindOf(tokenHash);
      if (!kind) return domainProblem(c, ["step_not_allowed"]);
      const address = normaliseContact(kind, c.req.valid("json").deliveryAddress);
      // Not an address at all: a syntax error, which counts nothing (D14).
      if (!address)
        return domainProblem(c, [{ code: "channel_invalid", field: "deliveryAddress" }]);
      return knowledgeCheck(
        c,
        sql`check_activation_delivery_address(${tokenHash}, ${keyedHash(addressKey, address)},
          ${c.get("requestId")})`,
      );
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/portal/activation/channel",
      tags: ["portal"],
      summary:
        "Send a one-time code to the private email or mobile the participant chose (committed first)",
      middleware: activating,
      request: {
        body: {
          required: true,
          content: { "application/json": { schema: ActivationChannelInput } },
        },
      },
      responses: {
        202: json(ActivationState, "Sent, or its outcome unknown: the code may still arrive"),
        ...problemResponses(
          "validation-error",
          "unauthenticated",
          "domain-error",
          "too-many-requests",
          "service-unavailable",
        ),
      },
    }),
    async (c) => {
      const { tokenHash } = portalSession(c);
      const input = c.req.valid("json");
      const address = normaliseContact(input.kind, input.address);
      if (!address) return domainProblem(c, [{ code: "channel_invalid", field: "address" }]);
      const sender = input.kind === "email" ? deps.mailer : deps.smsSender;
      // No provider configured (production has no mock): refuse before a code exists (D20).
      if (!sender) {
        return problem(c, "service-unavailable", {
          errors: [{ pointer: "", code: "delivery_unavailable", detail: "No delivery provider" }],
        });
      }
      const code = String(randomInt(0, 10 ** portalLimits.oneTimeCode.digits)).padStart(
        portalLimits.oneTimeCode.digits,
        "0",
      );
      const challengeId = randomUUID();
      try {
        await db.execute(sql`select create_one_time_code(${tokenHash},
          ${input.kind}::contact_channel_kind, ${address}, ${keyedHash(otpKey, code)},
          ${challengeId}::uuid) as result`);
      } catch (error) {
        return refused(c, error);
      }
      const message = oneTimeCodeMessage(input.language, code);
      // After the commit, with the row id as the idempotency key (D20). Any provider error counts
      // as unknown and is not logged: it may echo the destination.
      let outcome: "sent" | "failed" | "unknown";
      try {
        outcome = (
          input.kind === "email"
            ? await deps.mailer!.send({ to: address, ...message, idempotencyKey: challengeId })
            : await deps.smsSender!.send({
                to: address,
                text: message.text,
                idempotencyKey: challengeId,
              })
        ).status;
      } catch {
        outcome = "unknown";
      }
      await db.execute(sql`select record_one_time_code_delivery(${tokenHash},
        ${challengeId}::uuid, ${outcome}::activation_delivery_status) as result`);
      if (outcome === "failed") {
        return problem(c, "service-unavailable", {
          errors: [
            { pointer: "", code: "delivery_failed", detail: "Delivery failed definitively" },
          ],
        });
      }
      return c.json(await stateOf(tokenHash), 202);
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/portal/activation/completion",
      tags: ["portal"],
      summary:
        "Complete the activation in one transaction; the session becomes active with a new token",
      middleware: activating,
      request: {
        body: {
          required: true,
          content: { "application/json": { schema: ActivationCompletionInput } },
        },
      },
      responses: {
        201: json(PortalMe, "Activated and logged in"),
        ...problemResponses(
          "validation-error",
          "unauthenticated",
          "domain-error",
          "too-many-requests",
        ),
      },
    }),
    async (c) => {
      const limited = throttled(c);
      if (limited) return limited;
      const session = portalSession(c);
      const input = c.req.valid("json");
      let verification: ReturnType<typeof sql>;
      if (input.deliveryAddress !== undefined) {
        const kind = await deliveryKindOf(session.tokenHash);
        const address = kind ? normaliseContact(kind, input.deliveryAddress) : null;
        if (!address) {
          return domainProblem(c, [{ code: "channel_invalid", field: "deliveryAddress" }]);
        }
        verification = sql`p_delivery_address => ${address},
          p_delivery_address_hash => ${keyedHash(addressKey, address)}`;
      } else {
        verification = sql`p_one_time_code_hash => ${keyedHash(otpKey, input.oneTimeCode!)}`;
      }
      const next = newPortalToken();
      const channelId = randomUUID();
      // One transaction: the completion and, when it activates, the notice job (D21), so a
      // committed activation always has its notice queued.
      let result: string;
      try {
        result = await transactionWithClient(db, async (tx, client) => {
          const { rows } = await tx.execute<{ result: string }>(sql`
            select complete_activation(p_token_hash => ${session.tokenHash},
              p_new_token_hash => ${next.tokenHash}, p_notice_version => ${input.noticeVersion},
              p_consent_version => ${input.consentVersion},
              p_language => ${input.language}::notice_language,
              p_channel_id => ${channelId}::uuid, p_consent_id => ${randomUUID()}::uuid,
              p_request_id => ${c.get("requestId")}, ${verification}) as result`);
          const outcome = rows[0]!.result;
          if (outcome === ACTIVATED) {
            if (deps.activationNotices) {
              await deps.activationNotices.enqueue(channelId, {
                executeSql: (text, values) => client.query(text, values),
              });
            } else {
              deps.logger.warn({ channelId }, "activation notice not queued: jobs are disabled");
            }
          }
          return outcome;
        });
      } catch (error) {
        return refused(c, error);
      }
      if (result === "locked") return codeInvalid(c);
      if (result === "mismatch") return domainProblem(c, ["knowledge_check_failed"]);
      if (result !== ACTIVATED) return domainProblem(c, ["one_time_code_invalid"]);
      setPortalCookie(c, env, next.token);
      c.set("participant", { ...session, tokenHash: next.tokenHash, state: "active" });
      return c.json(await meOf(next.tokenHash), 201);
    },
  );

  /** The participant's greeting and channels, masked (D28); never an address or code. */
  async function meOf(tokenHash: string): Promise<PortalMe> {
    const { rows } = await db.execute<{
      firstName: string;
      language: NoticeLanguage;
      sessionExpiresAt: string;
      channels: { id: string; kind: ContactKind; address: string; verifiedAt: string }[];
    }>(sql`
      select i.first_name as "firstName", a.language,
        to_char(least(s.last_seen_at + ${sql.raw(`interval '${portalLimits.session.idleMinutes} minutes'`)},
          s.created_at + ${sql.raw(`interval '${portalLimits.session.absoluteHours} hours'`)})
          at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "sessionExpiresAt",
        coalesce((select json_agg(json_build_object('id', ch.id, 'kind', ch.kind,
            'address', ch.address, 'verifiedAt', to_char(ch.verified_at at time zone 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) order by ch.verified_at, ch.id)
          from participant_channel ch
          where ch.participation_id = s.participation_id and ch.removed_at is null), '[]')
          as channels
      from participant_session s
      join participant_account a on a.participation_id = s.participation_id
      join participant_identity i on i.participation_id = s.participation_id
      where s.token_hash = ${tokenHash}`);
    const { channels, ...me } = rows[0]!;
    return {
      ...me,
      channels: channels.map(({ address, ...channel }) => ({
        ...channel,
        maskedAddress: maskContactAddress(channel.kind, address),
      })),
    };
  }

  router.openapi(
    createRoute({
      method: "get",
      path: "/portal/me",
      tags: ["portal"],
      summary: "The logged-in participant: greeting, language and channels (masked)",
      middleware: active,
      responses: {
        200: json(PortalMe, "The participant"),
        ...problemResponses("unauthenticated"),
      },
    }),
    async (c) => {
      c.header("Cache-Control", "no-store");
      return c.json(await meOf(portalSession(c).tokenHash), 200);
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/portal/logout",
      tags: ["portal"],
      summary: "End the portal session (an active one's logout is audited)",
      request: {
        body: { required: true, content: { "application/json": { schema: z.strictObject({}) } } },
      },
      responses: { ...NoContent, ...problemResponses("validation-error", "forbidden") },
    }),
    async (c) => {
      const tokenHash = portalTokenHash(c, env);
      if (tokenHash) {
        await db.execute(
          sql`select end_participant_session(${tokenHash}, ${c.get("requestId")}) as result`,
        );
      }
      clearPortalCookie(c, env);
      return c.body(null, 204);
    },
  );

  return router;
}
