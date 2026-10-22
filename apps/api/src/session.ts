import { sql, type Database } from "@transfer/db";
import type { StaffLoginMethod, StaffUser } from "@transfer/domain";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createHash, randomBytes } from "node:crypto";
import type { AppEnv, Deps } from "./context";
import type { Env } from "./env";
import { problem } from "./problem";

// The server-side staff session store (ADR-0007, staff sessions). The cookie carries 32
// random bytes; `staff_session` keeps only their SHA-256, so a database read gives no live
// session. Both login modes start sessions here; the functions write them with their audit events.

/** `__Host-tp_staff` (Secure, so https only) outside development; `tp_staff` over http in dev. */
export const staffCookieName = (env: Pick<Env, "nodeEnv">) =>
  env.nodeEnv === "development" ? "tp_staff" : "__Host-tp_staff";

/** 32 bytes as base64url, without padding. */
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** The SHA-256 of the request's well-formed session token, if it carries one. */
function cookieTokenHash(c: Context, env: Env) {
  const token = getCookie(c, staffCookieName(env));
  return token !== undefined && tokenPattern.test(token) ? hashToken(token) : null;
}

function clearSessionCookie(c: Context, env: Env) {
  deleteCookie(c, staffCookieName(env), { path: "/", secure: env.nodeEnv !== "development" });
}

/** The OIDC identity a login authenticated; none for the dev stub. */
export type LoginIdentity = { issuer: string; subject: string } | null;

/**
 * Starts a session for `staffUserId` in `db` (a transaction or the pool) with a new token (no
 * fixation) and sets the cookie; the token the browser carried, if any, ends as `superseded`.
 * Refusals are the function's `P0001` codes (`unknown_account`, `account_deactivated`,
 * `identity_mismatch`). Returns when the session ends.
 */
export async function startSession(
  c: Context<AppEnv>,
  { env }: Deps,
  db: Pick<Database, "execute">,
  login: { staffUserId: string; method: StaffLoginMethod; identity: LoginIdentity },
) {
  const token = randomBytes(32).toString("base64url");
  const { rows } = await db.execute<{ expires_at: string }>(sql`
    select to_char(start_staff_session(
      p_staff_user_id => ${login.staffUserId}::uuid,
      p_token_hash => ${hashToken(token)},
      p_method => ${login.method},
      p_oidc_issuer => ${login.identity?.issuer ?? null}::text,
      p_oidc_subject => ${login.identity?.subject ?? null}::text,
      p_superseded_token_hash => ${cookieTokenHash(c, env)}::text,
      p_request_id => ${c.get("requestId")}
    ) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as expires_at`);
  const expiresAt = rows[0]!.expires_at;
  setCookie(c, staffCookieName(env), token, {
    httpOnly: true,
    secure: env.nodeEnv !== "development",
    sameSite: "Lax",
    path: "/",
    expires: new Date(expiresAt),
  });
  return expiresAt;
}

/** Ends the request's live session, if any (`staff_logout`), and clears the cookie. */
export async function endSession(c: Context<AppEnv>, { db, env }: Deps) {
  const tokenHash = cookieTokenHash(c, env);
  if (tokenHash !== null) {
    await db.execute(sql`select end_staff_session(${tokenHash}, ${c.get("requestId")}) as result`);
  }
  clearSessionCookie(c, env);
}

/**
 * Requires a live session and loads its staff user; 401 problem otherwise. Live means not
 * ended, not expired by database time and of an active account. A dead cookie stays: clearing
 * it here could delete the new cookie of a login answered just before (a request still in
 * flight with the superseded token), and the next login replaces it anyway.
 */
export function requireSession({ db, env }: Deps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const tokenHash = cookieTokenHash(c, env);
    const { rows } = tokenHash
      ? await db.execute<StaffUser & { expiresAt: string }>(sql`
          select u.id, u.display_name as "displayName", u.may_create_projects as "mayCreateProjects",
            coalesce((select json_agg(json_build_object('role', r.role, 'regionId', r.region_id)
                        order by r.role, r.region_id)
                      from staff_org_role r where r.staff_user_id = u.id), '[]') as "orgRoles",
            to_char(s.expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "expiresAt"
          from staff_session s join staff_user u on u.id = s.staff_user_id
          where s.token_hash = ${tokenHash} and s.ended_at is null and s.expires_at > now()
            and u.deactivated_at is null`)
      : { rows: [] };
    const session = rows[0];
    if (!session) return problem(c, "unauthenticated");
    const { expiresAt, ...user } = session;
    c.set("staffUser", user);
    c.set("sessionExpiresAt", expiresAt);
    c.set("staffSessionHash", tokenHash!);
    await next();
  };
}

/** The hash of the request's live staff session, in a route behind `requireSession`. */
export function sessionHash(c: Context<AppEnv>) {
  const hash = c.get("staffSessionHash");
  if (!hash) throw new Error("sessionHash() used in a route without requireSession");
  return hash;
}

/** The session user in a route behind `requireSession`. */
export function sessionUser(c: Context<AppEnv>) {
  const user = c.get("staffUser");
  if (!user) throw new Error("sessionUser() used in a route without requireSession");
  return user;
}
