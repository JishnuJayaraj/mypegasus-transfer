import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Deps } from "./context";
import type { OidcChecks } from "./oidc";

// The OIDC flow cookie `tp_oidc` (Slice 3 plan, API): `state`, `nonce`, the PKCE verifier and
// the return path between `GET /auth/login` and `GET /auth/callback`, for 10 minutes. Signed
// with HMAC-SHA256 under a key derived from SESSION_SECRET with HKDF (`oidc-flow-cookie:v1`),
// so it is never one of the import's keys; the expiry is inside the signed value, so the
// browser's Max-Age is no trust anchor. HttpOnly, only sent to the auth routes, SameSite=Lax:
// the identity provider returns with a top-level GET.

const COOKIE = "tp_oidc";
const PATH = "/api/v1/auth";
export const OIDC_FLOW_MINUTES = 10;

const Flow = z.strictObject({
  state: z.string().min(1).max(200),
  nonce: z.string().min(1).max(200),
  codeVerifier: z.string().min(43).max(128),
  returnTo: z.string().max(2000),
  expiresAt: z.int(),
});

export type OidcFlow = OidcChecks & { returnTo: string };

const flowKey = (secret: string) =>
  Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), "oidc-flow-cookie:v1", 32));

const sign = (key: Buffer, payload: string) =>
  createHmac("sha256", key).update(payload).digest("base64url");

export function setFlowCookie(c: Context, { env, clock }: Deps, flow: OidcFlow) {
  const expiresAt = clock.now().getTime() + OIDC_FLOW_MINUTES * 60_000;
  const payload = Buffer.from(JSON.stringify({ ...flow, expiresAt })).toString("base64url");
  setCookie(c, COOKIE, `${payload}.${sign(flowKey(env.sessionSecret), payload)}`, {
    httpOnly: true,
    secure: env.nodeEnv !== "development",
    sameSite: "Lax",
    path: PATH,
    maxAge: OIDC_FLOW_MINUTES * 60,
  });
}

/** The flow of a valid, unexpired cookie, or null; the cookie is cleared either way (one use). */
export function takeFlowCookie(c: Context, { env, clock }: Deps): OidcFlow | null {
  const value = getCookie(c, COOKIE);
  deleteCookie(c, COOKIE, { path: PATH, secure: env.nodeEnv !== "development" });
  const [payload, signature, ...rest] = value?.split(".") ?? [];
  if (!payload || !signature || rest.length > 0) return null;
  const expected = Buffer.from(sign(flowKey(env.sessionSecret), payload));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const flow = Flow.safeParse(parsed);
  if (!flow.success || flow.data.expiresAt <= clock.now().getTime()) return null;
  const { state, nonce, codeVerifier, returnTo } = flow.data;
  return { state, nonce, codeVerifier, returnTo };
}
