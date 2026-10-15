import { serveStatic } from "@hono/node-server/serve-static";
import type { MiddlewareHandler } from "hono";
import type { AppEnv, Router } from "./context";

/** Directories of the built SPAs (`vite build` output). */
export interface SpaRoots {
  web: string;
  portal: string;
}

const IMMUTABLE = "public, max-age=31536000, immutable";

/** A last path segment with an extension is a file request; anything else is a client route. */
const FILE_PATH = /\/[^/]*\.[^/]*$/;

const nothing = async () => {};

/**
 * One SPA under `prefix`: files from `root`, `index.html` for client-side routes. Vite's hashed
 * assets are immutable; everything else (above all `index.html`) must be revalidated. A missing
 * file falls through to the 404 problem rather than getting `index.html`.
 */
function spa(root: string, prefix: string): MiddlewareHandler<AppEnv> {
  const files = serveStatic<AppEnv>({
    root,
    rewriteRequestPath: (path) => path.slice(prefix.length),
  });
  const index = serveStatic<AppEnv>({ root, path: "index.html" });

  return async (c, next) => {
    if (c.req.path === "/api" || c.req.path.startsWith("/api/")) return next();
    const path = c.req.path.slice(prefix.length);
    let fallback: Response | void = undefined;
    const file = await files(c, async () => {
      if (!FILE_PATH.test(path)) fallback = await index(c, nothing);
    });
    const res = file instanceof Response ? file : fallback;
    if (!res) return next();
    const asset = res === file && path.startsWith("/assets/");
    res.headers.set("Cache-Control", asset ? IMMUTABLE : "no-cache");
    return res;
  };
}

/** Production: the web SPA at `/`, the portal at `/portal/` (D4, plan section 5.4). */
export function mountSpas(app: Router, roots: SpaRoots): void {
  app.get("/portal", (c) => c.redirect("/portal/", 301));
  app.get("/portal/*", spa(roots.portal, "/portal"));
  app.get("*", spa(roots.web, ""));
}
