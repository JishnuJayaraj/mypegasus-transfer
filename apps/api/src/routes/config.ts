import { createRoute, z } from "@hono/zod-openapi";
import { compareTemplateVersions, TemplateManifestEntry } from "@transfer/config";
import { configDirs, loadManifest } from "@transfer/config/load";
import { PageQuery, page } from "@transfer/domain";
import { readsTemplateCatalog, staffSubjectOf } from "../access";
import { createRouter, json, type Deps } from "../context";
import { templateCursor } from "../cursor";
import { problem, problemResponses } from "../problem";
import { requireSession, sessionUser } from "../session";

const TemplateCatalogPage = page(TemplateManifestEntry.meta({ id: "TemplateCatalogEntry" })).meta({
  id: "TemplateCatalogPage",
});
const CatalogQuery = z.strictObject(PageQuery.shape);

export function configRoutes(deps: Deps) {
  const router = createRouter();
  // Read once (S2): a missing or invalid catalog fails the start, never a request.
  const { templates } = loadManifest(configDirs(deps.env.configDir).templates);

  router.openapi(
    createRoute({
      method: "get",
      path: "/config/templates",
      tags: ["config"],
      summary: "The template catalog: every Agentur template version of this release (plan 5.8)",
      middleware: [requireSession(deps)],
      request: { query: CatalogQuery },
      responses: {
        200: json(TemplateCatalogPage, "A page of template versions, by key and version"),
        ...problemResponses("validation-error", "unauthenticated", "forbidden"),
      },
    }),
    async (c) => {
      const { limit, cursor: rawCursor } = c.req.valid("query");
      const cursor = rawCursor === undefined ? undefined : templateCursor.decode(rawCursor);
      if (rawCursor !== undefined && !cursor) {
        return problem(c, "validation-error", {
          errors: [{ parameter: "cursor", code: "invalid_cursor", detail: "Malformed cursor" }],
        });
      }
      const user = sessionUser(c);
      if (!readsTemplateCatalog(await staffSubjectOf(deps.db, user), user)) {
        return problem(c, "forbidden");
      }
      const rest = cursor
        ? templates.filter((t) => compareTemplateVersions(t, cursor) > 0)
        : templates;
      const items = rest.slice(0, limit);
      const last = items.at(-1);
      const nextCursor =
        rest.length > limit && last
          ? templateCursor.encode({ agenturKey: last.agenturKey, version: last.version })
          : null;
      return c.json({ items, nextCursor }, 200);
    },
  );

  return router;
}
