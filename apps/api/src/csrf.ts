import type { MiddlewareHandler } from "hono";
import { problem } from "./problem";

const unsafeMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * CSRF (Slice 3 plan, D4): every unsafe method needs an `Origin` in APP_ORIGINS or, from a
 * browser that sends none, `Sec-Fetch-Site: same-origin`; anything else is a 403 `csrf_origin`.
 * Unlike Hono's `csrf()` it checks every content type. With JSON-only bodies, no CORS and
 * `SameSite=Lax` cookies, no token scheme is needed.
 */
export function originCheck(appOrigins: readonly string[]): MiddlewareHandler {
  return async (c, next) => {
    if (unsafeMethods.has(c.req.method)) {
      const origin = c.req.header("origin");
      const allowed =
        origin === undefined
          ? c.req.header("sec-fetch-site") === "same-origin"
          : appOrigins.includes(origin);
      if (!allowed) {
        return problem(c, "forbidden", {
          errors: [
            { pointer: "", code: "csrf_origin", detail: "The request's origin is not allowed" },
          ],
        });
      }
    }
    await next();
  };
}
