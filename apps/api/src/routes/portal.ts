import { createRoute, z } from "@hono/zod-openapi";
import { and, eq, participantChannel, sql, transactionWithClient } from "@transfer/db";
import {
  ART14_NOTICE_VERSION,
  ActivationBirthDateInput,
  ActivationChannelInput,
  ActivationCodeInput,
  ActivationCompletionInput,
  ActivationDeliveryAddressInput,
  ActivationState,
  ChannelCodeRequestInput,
  ChannelRemovalResult,
  ConsentUpgradeInput,
  ConsentUpgradeResult,
  consentUpgradeOffered,
  ChannelVerificationInput,
  LoginCodeRequestInput,
  LoginInput,
  PORTAL_CONTACT_CONSENT_VERSION,
  PortalChannels,
  PortalMe,
  maskContactAddress,
  nextActivationStep,
  normaliseActivationCode,
  normaliseContact,
  portalLimits,
  PortalStepUp,
  StepUpBirthDateInput,
  StepUpCodeInput,
  StepUpCodeRequestInput,
  type ActivationChannel,
  type ActivationPurpose,
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
  portalStepUp,
  portalTokenHash,
  requirePortalSession,
  setPortalCookie,
} from "../portal-session";
import { clientIp, createThrottle } from "../throttle";

// The participant's activation and recovery, login, channels and the step-up before
// special-category data; the rules are ADR-0007 and data-protection.md, Authentication. Codes,
// one-time codes, birth dates and addresses arrive only in bodies and leave only as keyed hashes
// for the functions (an address also to its own sender); no response, log line or audit row
// carries them. Every code submission passes the per-IP throttle (Q128). The login never says
// whether an address belongs to an account.

const NoContent = { 204: { description: "Done" } };
const StepUpCodeSent = {
  202: { description: "Sent, or its outcome unknown: the code may still arrive" },
};
/** `complete_activation`'s results that leave an active session. */
const COMPLETED = new Set(["activated", "recovered"]);
const ChannelParams = z.object({ channelId: z.uuid() });

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

/** A six-digit one-time code (ADR-0007). */
function newOneTimeCode() {
  return String(randomInt(0, 10 ** portalLimits.oneTimeCode.digits)).padStart(
    portalLimits.oneTimeCode.digits,
    "0",
  );
}

/**
 * The login message (ADR-0007): the code and, by email, a link with it in the fragment, which the
 * login page reads and posts only on a click.
 */
function loginCodeMessage(language: NoticeLanguage, code: string, link: string) {
  const validity = portalLimits.oneTimeCode.validityMinutes;
  return language === "de"
    ? {
        subject: "Ihr Anmeldecode für das Teilnehmerportal",
        text: `Ihr Anmeldecode lautet ${code}. Er gilt ${validity} Minuten. Geben Sie ihn niemandem weiter.`,
        link: `Oder öffnen Sie diesen Link und klicken Sie dort auf „Anmelden“: ${link}\n\nWenn Sie keinen Code angefordert haben, können Sie diese Nachricht ignorieren.`,
      }
    : {
        subject: "Your login code for the participant portal",
        text: `Your login code is ${code}. It is valid for ${validity} minutes. Do not share it with anyone.`,
        link: `Or open this link and select “Log in” there: ${link}\n\nIf you did not ask for a code, you can ignore this message.`,
      };
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

function rateLimited(c: Context<AppEnv>, retryAfterSeconds: number) {
  c.header("Retry-After", String(retryAfterSeconds));
  return problem(c, "too-many-requests", {
    errors: [{ pointer: "", code: "rate_limited", detail: "Please try again later" }],
  });
}

/** 503 before any code exists when no provider is configured (ADR-0006). */
function deliveryUnavailable(c: Context<AppEnv>) {
  return problem(c, "service-unavailable", {
    errors: [{ pointer: "", code: "delivery_unavailable", detail: "No delivery provider" }],
  });
}

function deliveryFailed(c: Context<AppEnv>) {
  return problem(c, "service-unavailable", {
    errors: [{ pointer: "", code: "delivery_failed", detail: "Delivery failed definitively" }],
  });
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
  // ADR-0007: login codes per address and hour, counted for every address alike (keyed hashes, in
  // memory) so a `429` doesn't tell a known address from an unknown one; the database counts
  // login and verification codes of known addresses together as well.
  const loginRequests = createThrottle({
    limit: portalLimits.oneTimeCode.requestsPerAddressPerHour,
    windowMs: minutes(60),
    clock: deps.clock,
  });
  const loginLink = (code: string) => {
    const base = env.portalPublicUrl!;
    const url = new URL("login", base.endsWith("/") ? base : `${base}/`);
    url.hash = code;
    return url.href;
  };

  /** 429 `rate_limited` when the client's IP has used up its submissions. */
  function throttled(c: Context<AppEnv>) {
    const taken = throttle.take(clientIp(c));
    return taken.ok ? undefined : rateLimited(c, taken.retryAfterSeconds);
  }

  /**
   * Sends a one-time code after its commit with the row id as the idempotency key (ADR-0006). Any
   * provider error counts as unknown and is not logged: it may echo the destination.
   */
  async function sendOneTimeCode(
    kind: ContactKind,
    to: string,
    message: { subject: string; text: string; link?: string },
    idempotencyKey: string,
  ): Promise<"sent" | "failed" | "unknown"> {
    try {
      return (
        kind === "email"
          ? await deps.mailer!.send({
              to,
              subject: message.subject,
              text: message.link ? `${message.text}\n\n${message.link}` : message.text,
              idempotencyKey,
            })
          : await deps.smsSender!.send({ to, text: message.text, idempotencyKey })
      ).status;
    } catch {
      return "unknown";
    }
  }

  /** A refusal of a function: 401 for a dead session, 422 with its code, or rethrown. */
  function refused(c: Context<AppEnv>, error: unknown) {
    const code = functionRefusal(error);
    if (code === "session_invalid") return problem(c, "unauthenticated");
    if (code === "rate_limited") return rateLimited(c, 3600);
    if (code === "code_invalid") clearPortalCookie(c, env);
    if (code && domainRefusals.has(code)) return domainProblem(c, [code]);
    throw error;
  }

  /** The generic answer to any code that can't be used (ADR-0007, Q128), which ends the browser's session. */
  function codeInvalid(c: Context<AppEnv>) {
    clearPortalCookie(c, env);
    return domainProblem(c, [{ code: "code_invalid", field: null }]);
  }

  /** Where the session's activation stands (ADR-0007, steps), from its code and the steps it recorded. */
  async function stateOf(tokenHash: string): Promise<ActivationState> {
    const { rows } = await db.execute<{
      purpose: ActivationPurpose;
      channel: ActivationChannel;
      deliveryKind: ContactKind | null;
      language: NoticeLanguage;
      hasBirthDate: boolean;
      birthDateChecked: boolean;
      deliveryAddressChecked: boolean;
      oneTimeCodeSent: boolean;
    }>(sql`
      select c.purpose, c.channel, c.delivery_kind as "deliveryKind",
        c.notice_language as language,
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
    const { purpose, channel, deliveryKind, language, ...progress } = rows[0]!;
    return {
      nextStep: nextActivationStep({ channel, ...progress }),
      purpose,
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
      // A malformed code counts nothing on any code (Q128): the generic answer.
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

  /** Runs a knowledge check; `mismatch` and `locked` are its counted failures (Q128). */
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
      // Not an address at all: a syntax error, which counts nothing (Q128).
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
      // No provider configured (production has no mock): refuse before a code exists (ADR-0006).
      if (!sender) return deliveryUnavailable(c);
      const code = newOneTimeCode();
      const challengeId = randomUUID();
      try {
        await db.execute(sql`select create_one_time_code(${tokenHash},
          ${input.kind}::contact_channel_kind, ${address}, ${keyedHash(otpKey, code)},
          ${challengeId}::uuid) as result`);
      } catch (error) {
        return refused(c, error);
      }
      const outcome = await sendOneTimeCode(
        input.kind,
        address,
        oneTimeCodeMessage(input.language, code),
        challengeId,
      );
      await db.execute(sql`select record_one_time_code_delivery(${tokenHash},
        ${challengeId}::uuid, ${outcome}::activation_delivery_status) as result`);
      if (outcome === "failed") return deliveryFailed(c);
      return c.json(await stateOf(tokenHash), 202);
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/portal/activation/completion",
      tags: ["portal"],
      summary:
        "Complete the activation or recovery in one transaction; the session becomes active with a new token",
      middleware: activating,
      request: {
        body: {
          required: true,
          content: { "application/json": { schema: ActivationCompletionInput } },
        },
      },
      responses: {
        201: json(PortalMe, "Activated (or recovered) and logged in"),
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
      // One transaction: the completion and, when it activates, the notice job (ADR-0011), so a
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
          if (COMPLETED.has(outcome)) {
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
      if (!COMPLETED.has(result)) return domainProblem(c, ["one_time_code_invalid"]);
      setPortalCookie(c, env, next.token);
      c.set("participant", { ...session, tokenHash: next.tokenHash, state: "active" });
      return c.json(await meOf(next.tokenHash), 201);
    },
  );

  /** The participant's greeting and channels, masked (Q123); never an address or code. */
  async function meOf(tokenHash: string): Promise<PortalMe> {
    const { rows } = await db.execute<{
      firstName: string;
      language: NoticeLanguage;
      sessionExpiresAt: string;
      channels: {
        id: string;
        kind: ContactKind;
        address: string;
        verifiedAt: string;
        live: boolean;
        consentVersion: string;
      }[];
    }>(sql`
      select i.first_name as "firstName", a.language,
        to_char(least(s.last_seen_at + ${sql.raw(`interval '${portalLimits.session.idleMinutes} minutes'`)},
          s.created_at + ${sql.raw(`interval '${portalLimits.session.absoluteHours} hours'`)})
          at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "sessionExpiresAt",
        coalesce((select json_agg(json_build_object('id', ch.id, 'kind', ch.kind,
            'address', ch.address, 'verifiedAt', to_char(ch.verified_at at time zone 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), 'live', ch.suspended_at is null,
            'consentVersion', k.text_version) order by ch.verified_at, ch.id)
          from participant_channel ch join consent_record k on k.id = ch.consent_id
          where ch.participation_id = s.participation_id and ch.removed_at is null), '[]')
          as channels
      from participant_session s
      join participant_account a on a.participation_id = s.participation_id
      join participant_identity i on i.participation_id = s.participation_id
      where s.token_hash = ${tokenHash}`);
    const { channels, ...me } = rows[0]!;
    return {
      ...me,
      channels: channels.map(({ address, live, consentVersion, ...channel }) => ({
        ...channel,
        maskedAddress: maskContactAddress(channel.kind, address),
        consentUpgrade: consentUpgradeOffered({ live, consentVersion }),
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

  router.openapi(
    createRoute({
      method: "post",
      path: "/portal/login/code-request",
      tags: ["portal"],
      summary:
        "Send a login code to a registered address; 202 whether or not the address has an account",
      request: {
        body: {
          required: true,
          content: { "application/json": { schema: LoginCodeRequestInput } },
        },
      },
      responses: {
        202: { description: "Accepted: a code goes out if the address belongs to an account" },
        ...problemResponses(
          "validation-error",
          "domain-error",
          "too-many-requests",
          "service-unavailable",
        ),
      },
    }),
    async (c) => {
      const limited = throttled(c);
      if (limited) return limited;
      const input = c.req.valid("json");
      const address = normaliseContact(input.kind, input.address);
      // Not an address at all: says nothing about any account.
      if (!address) return domainProblem(c, [{ code: "channel_invalid", field: "address" }]);
      // Depends on the kind only, never on the address (ADR-0006).
      if (!(input.kind === "email" ? deps.mailer : deps.smsSender)) return deliveryUnavailable(c);
      const perAddress = loginRequests.take(keyedHash(addressKey, `${input.kind}:${address}`));
      if (!perAddress.ok) return rateLimited(c, perAddress.retryAfterSeconds);
      const code = newOneTimeCode();
      let challengeId: string | null;
      try {
        const { rows } = await db.execute<{ result: string | null }>(sql`
          select request_login_code(${input.kind}::contact_channel_kind, ${address},
            ${keyedHash(otpKey, code)}, ${randomUUID()}::uuid) as result`);
        challengeId = rows[0]!.result;
      } catch (error) {
        // The database's own limit counts verification codes of known addresses too: answering
        // it would tell them apart, so the request is accepted and nothing is sent.
        if (functionRefusal(error) !== "rate_limited") throw error;
        challengeId = null;
      }
      if (challengeId) {
        const id = challengeId;
        // The send finishes after the response, so a known address isn't slower (ADR-0007).
        deps.detached!.run("login-code", async () => {
          const outcome = await sendOneTimeCode(
            input.kind,
            address,
            loginCodeMessage(input.language, code, loginLink(code)),
            id,
          );
          await db.execute(sql`select record_login_code_delivery(${id}::uuid,
            ${outcome}::activation_delivery_status) as result`);
        });
      }
      return c.body(null, 202);
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/portal/login",
      tags: ["portal"],
      summary: "Log in with the code sent to the address; sets the portal session cookie",
      request: {
        body: { required: true, content: { "application/json": { schema: LoginInput } } },
      },
      responses: {
        200: json(PortalMe, "Logged in"),
        ...problemResponses("validation-error", "domain-error", "too-many-requests"),
      },
    }),
    async (c) => {
      const limited = throttled(c);
      if (limited) return limited;
      const input = c.req.valid("json");
      const address = normaliseContact(input.kind, input.address);
      // One answer for an unknown address, a wrong, expired or used code and the fifth wrong
      // entry: none of them may tell whether the address has an account.
      if (!address) return domainProblem(c, ["one_time_code_invalid"]);
      const { token, tokenHash } = newPortalToken();
      const { rows } = await db.execute<{ result: string }>(sql`
        select start_participant_session(${input.kind}::contact_channel_kind, ${address},
          ${keyedHash(otpKey, input.oneTimeCode)}, ${tokenHash}, ${c.get("requestId")}) as result`);
      if (rows[0]!.result !== "ok") return domainProblem(c, ["one_time_code_invalid"]);
      setPortalCookie(c, env, token);
      c.header("Cache-Control", "no-store");
      return c.json(await meOf(tokenHash), 200);
    },
  );

  router.openapi(
    createRoute({
      method: "get",
      path: "/portal/channels",
      tags: ["portal"],
      summary: "The participant's own channels, masked",
      middleware: active,
      responses: {
        200: json(PortalChannels, "The channels"),
        ...problemResponses("unauthenticated"),
      },
    }),
    async (c) => {
      c.header("Cache-Control", "no-store");
      const { channels } = await meOf(portalSession(c).tokenHash);
      return c.json({ channels }, 200);
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/portal/channels",
      tags: ["portal"],
      summary: "Send a verification code to a new private email or mobile (committed first)",
      middleware: active,
      request: {
        body: {
          required: true,
          content: { "application/json": { schema: ChannelCodeRequestInput } },
        },
      },
      responses: {
        202: { description: "Sent, or its outcome unknown: the code may still arrive" },
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
      if (!(input.kind === "email" ? deps.mailer : deps.smsSender)) return deliveryUnavailable(c);
      const code = newOneTimeCode();
      const challengeId = randomUUID();
      try {
        await db.execute(sql`select request_channel_code(${tokenHash},
          ${input.kind}::contact_channel_kind, ${address}, ${keyedHash(otpKey, code)},
          ${challengeId}::uuid) as result`);
      } catch (error) {
        return refused(c, error);
      }
      const outcome = await sendOneTimeCode(
        input.kind,
        address,
        oneTimeCodeMessage(input.language, code),
        challengeId,
      );
      await db.execute(sql`select record_one_time_code_delivery(${tokenHash},
        ${challengeId}::uuid, ${outcome}::activation_delivery_status) as result`);
      if (outcome === "failed") return deliveryFailed(c);
      return c.body(null, 202);
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/portal/channels/verification",
      tags: ["portal"],
      summary: "Add the new channel with the code sent to it and its own consent",
      middleware: active,
      request: {
        body: {
          required: true,
          content: { "application/json": { schema: ChannelVerificationInput } },
        },
      },
      responses: {
        201: json(PortalChannels, "Added; the channels now"),
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
      const input = c.req.valid("json");
      let result: string;
      try {
        const { rows } = await db.execute<{ result: string }>(sql`
          select add_participant_channel(${tokenHash}, ${keyedHash(otpKey, input.oneTimeCode)},
            ${randomUUID()}::uuid, ${randomUUID()}::uuid, ${input.consentVersion},
            ${input.language}::notice_language, ${c.get("requestId")}) as result`);
        result = rows[0]!.result;
      } catch (error) {
        return refused(c, error);
      }
      if (result !== "added") return domainProblem(c, ["one_time_code_invalid"]);
      const { channels } = await meOf(tokenHash);
      return c.json({ channels }, 201);
    },
  );

  router.openapi(
    createRoute({
      method: "delete",
      path: "/portal/channels/{channelId}",
      tags: ["portal"],
      summary:
        "Remove a channel and end its consent; removing the last one ends the participant's sessions",
      middleware: active,
      request: { params: ChannelParams },
      responses: {
        200: json(ChannelRemovalResult, "Removed"),
        ...problemResponses(
          "validation-error",
          "unauthenticated",
          "not-found",
          "domain-error",
          "too-many-requests",
        ),
      },
    }),
    async (c) => {
      const { channelId } = c.req.valid("param");
      let sessionEnded: boolean;
      try {
        const { rows } = await db.execute<{ result: boolean }>(sql`
          select remove_participant_channel(${portalSession(c).tokenHash}, ${channelId}::uuid,
            ${c.get("requestId")}) as result`);
        sessionEnded = rows[0]!.result;
      } catch (error) {
        if (functionRefusal(error) === "channel_not_found") return problem(c, "not-found");
        return refused(c, error);
      }
      if (sessionEnded) clearPortalCookie(c, env);
      return c.json({ sessionEnded }, 200);
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/portal/channels/{channelId}/consent-upgrade",
      tags: ["portal"],
      summary:
        "Give consent v2 for one of the participant's own channels (voluntary; the address isn't verified again)",
      middleware: active,
      request: {
        params: ChannelParams,
        body: {
          required: true,
          content: { "application/json": { schema: ConsentUpgradeInput } },
        },
      },
      responses: {
        200: json(ConsentUpgradeResult, "Upgraded, or already v2"),
        ...problemResponses(
          "validation-error",
          "unauthenticated",
          "not-found",
          "domain-error",
          "too-many-requests",
        ),
      },
    }),
    async (c) => {
      const { channelId } = c.req.valid("param");
      const input = c.req.valid("json");
      let result: "upgraded" | "already_current";
      try {
        const { rows } = await db.execute<{ result: "upgraded" | "already_current" }>(sql`
          select upgrade_channel_consent(${portalSession(c).tokenHash}, ${channelId}::uuid,
            ${randomUUID()}::uuid, ${input.consentVersion}, ${input.language}::notice_language,
            ${c.get("requestId")}) as result`);
        result = rows[0]!.result;
      } catch (error) {
        if (functionRefusal(error) === "channel_not_found") return problem(c, "not-found");
        return refused(c, error);
      }
      return c.json({ result }, 200);
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/portal/step-up/birth-date",
      tags: ["portal"],
      summary:
        "The step-up of a birth-date account: the birth date again; the fifth wrong one ends the session (step_up_failed)",
      middleware: active,
      request: {
        body: { required: true, content: { "application/json": { schema: StepUpBirthDateInput } } },
      },
      responses: {
        200: json(PortalStepUp, "Stepped up for this session"),
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
      let result: string;
      try {
        const { rows } = await db.execute<{ result: string }>(sql`
          select check_step_up_birth_date(${tokenHash}, ${c.req.valid("json").birthDate}::date,
            ${c.get("requestId")}) as result`);
        result = rows[0]!.result;
      } catch (error) {
        return refused(c, error);
      }
      if (result === "ended") {
        clearPortalCookie(c, env);
        return domainProblem(c, ["step_up_failed"]);
      }
      if (result === "mismatch") return domainProblem(c, ["knowledge_check_failed"]);
      return c.json(await portalStepUp(db, tokenHash), 200);
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/portal/step-up/code-request",
      tags: ["portal"],
      summary:
        "The step-up of a photo-ID account: send a step-up code to one of its channels (committed first)",
      middleware: active,
      request: {
        body: {
          required: true,
          content: { "application/json": { schema: StepUpCodeRequestInput } },
        },
      },
      responses: {
        ...StepUpCodeSent,
        ...problemResponses(
          "validation-error",
          "unauthenticated",
          "not-found",
          "domain-error",
          "too-many-requests",
          "service-unavailable",
        ),
      },
    }),
    async (c) => {
      const limited = throttled(c);
      if (limited) return limited;
      const { tokenHash, participationId } = portalSession(c);
      const input = c.req.valid("json");
      const [channel] = await db
        .select({ kind: participantChannel.kind })
        .from(participantChannel)
        .where(
          and(
            eq(participantChannel.id, input.channelId),
            eq(participantChannel.participationId, participationId),
          ),
        );
      if (!channel) return problem(c, "not-found");
      // No provider for the kind: refuse before a code exists (ADR-0006).
      if (!(channel.kind === "email" ? deps.mailer : deps.smsSender)) {
        return deliveryUnavailable(c);
      }
      const code = newOneTimeCode();
      const challengeId = randomUUID();
      let to: { kind: ContactKind; address: string };
      try {
        const { rows } = await db.execute<{ result: { kind: ContactKind; address: string } }>(sql`
          select request_step_up_code(${tokenHash}, ${input.channelId}::uuid,
            ${keyedHash(otpKey, code)}, ${challengeId}::uuid) as result`);
        to = rows[0]!.result;
      } catch (error) {
        if (functionRefusal(error) === "channel_not_found") return problem(c, "not-found");
        return refused(c, error);
      }
      const outcome = await sendOneTimeCode(
        to.kind,
        to.address,
        oneTimeCodeMessage(input.language, code),
        challengeId,
      );
      await db.execute(sql`select record_one_time_code_delivery(${tokenHash},
        ${challengeId}::uuid, ${outcome}::activation_delivery_status) as result`);
      if (outcome === "failed") return deliveryFailed(c);
      return c.body(null, 202);
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/portal/step-up/code",
      tags: ["portal"],
      summary:
        "The step-up code; a login code never counts. Five wrong entries end the code, not the session",
      middleware: active,
      request: {
        body: { required: true, content: { "application/json": { schema: StepUpCodeInput } } },
      },
      responses: {
        200: json(PortalStepUp, "Stepped up for this session"),
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
      let result: string;
      try {
        const { rows } = await db.execute<{ result: string }>(sql`
          select verify_step_up_code(${tokenHash},
            ${keyedHash(otpKey, c.req.valid("json").oneTimeCode)}, ${c.get("requestId")}) as result`);
        result = rows[0]!.result;
      } catch (error) {
        return refused(c, error);
      }
      if (result !== "ok") return domainProblem(c, ["one_time_code_invalid"]);
      return c.json(await portalStepUp(db, tokenHash), 200);
    },
  );

  return router;
}
