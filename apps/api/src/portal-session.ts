import { sql, type Database } from "@transfer/db";
import { portalLimits, type ParticipantSessionState } from "@transfer/domain";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createHash, randomBytes } from "node:crypto";
import type { AppEnv, Deps } from "./context";
import type { Env } from "./env";
import { problem } from "./problem";

// Participant sessions (ADR-0007; Slice 3 plan D3, D29): like the staff store, the cookie carries
// 32 random bytes and `participant_session` keeps only their SHA-256. Portal routes read only the
// portal cookie. The activation functions write the rows; the API reads them and moves
// `last_seen_at`, at most once a minute.

export type PortalSession = {
  tokenHash: string;
  participationId: string;
  projectId: string;
  state: ParticipantSessionState;
  /** When the session ends unless used again (ISO 8601 UTC): idle or absolute, whichever first. */
  expiresAt: string;
};

/** `__Host-tp_portal` (Secure) outside development; `tp_portal` over http in development. */
export const portalCookieName = (env: Pick<Env, "nodeEnv">) =>
  env.nodeEnv === "development" ? "tp_portal" : "__Host-tp_portal";

const tokenPattern = /^[A-Za-z0-9_-]{43}$/;

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** A new session token and its hash. */
export function newPortalToken() {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashToken(token) };
}

/** The SHA-256 of the request's well-formed portal token, if it carries one. */
export function portalTokenHash(c: Context, env: Env) {
  const token = getCookie(c, portalCookieName(env));
  return token !== undefined && tokenPattern.test(token) ? hashToken(token) : null;
}

const { idleMinutes, absoluteHours, lastSeenWriteSeconds } = portalLimits.session;

export function setPortalCookie(c: Context, env: Env, token: string) {
  setCookie(c, portalCookieName(env), token, {
    httpOnly: true,
    secure: env.nodeEnv !== "development",
    sameSite: "Lax",
    path: "/",
    // The absolute limit; the idle limit is the server's.
    maxAge: absoluteHours * 60 * 60,
  });
}

export function clearPortalCookie(c: Context, env: Env) {
  deleteCookie(c, portalCookieName(env), { path: "/", secure: env.nodeEnv !== "development" });
}

/** The live session of `tokenHash` (database time), its `last_seen_at` moved when due. */
export async function livePortalSession(
  db: Database,
  tokenHash: string,
): Promise<PortalSession | undefined> {
  const { rows } = await db.execute<PortalSession>(sql`
    with live as (
      select * from participant_session
      where token_hash = ${tokenHash} and ended_at is null
        and last_seen_at > now() - ${sql.raw(`interval '${idleMinutes} minutes'`)}
        and created_at > now() - ${sql.raw(`interval '${absoluteHours} hours'`)}
    ), touched as (
      update participant_session s set last_seen_at = now()
      from live where s.token_hash = live.token_hash
        and live.last_seen_at < now() - ${sql.raw(`interval '${lastSeenWriteSeconds} seconds'`)}
      returning s.token_hash
    )
    select token_hash as "tokenHash", participation_id as "participationId",
      project_id as "projectId", state,
      to_char(least(now() + ${sql.raw(`interval '${idleMinutes} minutes'`)},
        created_at + ${sql.raw(`interval '${absoluteHours} hours'`)}) at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "expiresAt"
    from live`);
  return rows[0];
}

/**
 * Requires a live portal session in `state`; 401 otherwise. An `activating` session opens only the
 * activation steps (D29); the functions check it again under their locks.
 */
export function requirePortalSession(
  { db, env }: Deps,
  state: ParticipantSessionState,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const tokenHash = portalTokenHash(c, env);
    const session = tokenHash ? await livePortalSession(db, tokenHash) : undefined;
    if (!session || session.state !== state) return problem(c, "unauthenticated");
    c.set("participant", session);
    await next();
  };
}

/** The portal session in a route behind `requirePortalSession`. */
export function portalSession(c: Context<AppEnv>) {
  const session = c.get("participant");
  if (!session) throw new Error("portalSession() used in a route without requirePortalSession");
  return session;
}
