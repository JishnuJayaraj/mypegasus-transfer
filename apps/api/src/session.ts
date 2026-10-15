import { eq, staffUser } from "@transfer/db";

import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import type { AppEnv, Deps } from "./context";
import { problem } from "./problem";

// Dev stub (ADR-0007): a signed cookie with the staff user id and the issue time. The
// server-side session store, the 8-hour lifetime and OIDC come in Slice 3.
const COOKIE = "tp_staff_session";

export function setSession(c: Context, { env }: Deps, staffUserId: string) {
  return setSignedCookie(c, COOKIE, `${staffUserId}.${Date.now()}`, env.sessionSecret, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    secure: env.nodeEnv !== "development",
  });
}

export function clearSession(c: Context) {
  deleteCookie(c, COOKIE, { path: "/" });
}

/** Requires a valid session and loads its staff user; 401 problem otherwise. */
export function requireSession({ db, env }: Deps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const value = await getSignedCookie(c, env.sessionSecret, COOKIE);
    const id = value ? value.split(".")[0] : undefined;
    const [user] = id
      ? await db
          .select({ id: staffUser.id, displayName: staffUser.displayName, role: staffUser.role })
          .from(staffUser)
          .where(eq(staffUser.id, id))
      : [];
    if (!user) return problem(c, "unauthenticated");
    c.set("staffUser", user);
    await next();
  };
}

/** The session user in a route behind `requireSession`. */
export function sessionUser(c: Context<AppEnv>) {
  const user = c.get("staffUser");
  if (!user) throw new Error("sessionUser() used in a route without requireSession");
  return user;
}
