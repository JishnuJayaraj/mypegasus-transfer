import { createRoute, z } from "@hono/zod-openapi";
import { safeReturnPath } from "@transfer/domain";
import type { Context } from "hono";
import { createRouter, type AppEnv, type Deps } from "../context";
import { errorForLog } from "../logger";
import type { Oidc } from "../oidc";
import { setFlowCookie, takeFlowCookie } from "../oidc-flow-cookie";
import { problemResponses } from "../problem";
import { endSession } from "../session";
import { loginWithOidc } from "../staff-login";

// Staff login and logout (ADR-0007; Slice 3 plan D1–D5, flow 1). Login and callback are browser
// navigations, so they answer with redirects: to the identity provider, back to the return path,
// or to the login page with a code (`/login?error=<code>`): the refusal codes, or `login_failed`
// for a callback that fails its checks. Never a claim, token or email in a URL or log line.

const tags = ["session"];
const noStore = { "Cache-Control": "no-store" };

const loginPage = (c: Context, code: string) =>
  c.body(null, 302, { ...noStore, Location: `/login?error=${code}` });

/** `GET /auth/login` and `GET /auth/callback`, with AUTH_MODE=oidc. */
export function oidcRoutes(deps: Deps, oidc: Oidc) {
  const { logger } = deps;
  const router = createRouter();
  const failed = (c: Context<AppEnv>, error: unknown) => {
    logger.warn({ requestId: c.get("requestId"), error: errorForLog(error) }, "oidc login failed");
    return loginPage(c, "login_failed");
  };

  router.openapi(
    createRoute({
      method: "get",
      path: "/auth/login",
      tags,
      summary: "Start a staff login at the identity provider (authorization code flow with PKCE)",
      request: {
        query: z.object({
          returnTo: z
            .string()
            .optional()
            .meta({ description: "A staff route to return to; anything else returns to /" }),
        }),
      },
      responses: {
        302: { description: "To the identity provider, or to the login page with `login_failed`" },
        ...problemResponses("validation-error"),
      },
    }),
    async (c) => {
      try {
        const { url, checks } = await oidc.authorize();
        setFlowCookie(c, deps, {
          ...checks,
          returnTo: safeReturnPath(c.req.valid("query").returnTo),
        });
        return c.body(null, 302, { ...noStore, Location: url });
      } catch (error) {
        return failed(c, error);
      }
    },
  );

  router.openapi(
    createRoute({
      method: "get",
      path: "/auth/callback",
      tags,
      summary: "The identity provider's redirect: checks state, nonce and PKCE, starts the session",
      responses: {
        302: {
          description:
            "To the return path with the session cookie, or to the login page with a code: `unknown_account`, `account_deactivated`, `identity_mismatch`, `login_failed`",
        },
      },
    }),
    async (c) => {
      const flow = takeFlowCookie(c, deps);
      if (!flow) return failed(c, new Error("no valid oidc flow cookie"));
      let identity;
      try {
        identity = await oidc.callback(new URL(c.req.url).search, flow);
      } catch (error) {
        return failed(c, error);
      }
      const result = await loginWithOidc(c, deps, identity);
      if (!result.ok) return loginPage(c, result.code);
      return c.body(null, 302, { ...noStore, Location: safeReturnPath(flow.returnTo) });
    },
  );

  return router;
}

/** `POST /auth/logout`, in both modes. */
export function logoutRoutes(deps: Deps) {
  const router = createRouter();
  router.openapi(
    createRoute({
      method: "post",
      path: "/auth/logout",
      tags,
      summary: "End the staff session (clears the cookie); 204 with or without one",
      request: {
        body: { required: true, content: { "application/json": { schema: z.strictObject({}) } } },
      },
      responses: {
        204: { description: "Logged out" },
        ...problemResponses("validation-error", "forbidden", "unsupported-media-type"),
      },
    }),
    async (c) => {
      await endSession(c, deps);
      return c.body(null, 204);
    },
  );
  return router;
}
