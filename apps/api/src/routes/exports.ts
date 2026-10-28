import { createRoute, z } from "@hono/zod-openapi";
import { FileNotFound, mergePdfs } from "@transfer/adapters";
import { sql } from "@transfer/db";
import {
  ExportContentParams,
  ExportInput,
  ExportLink,
  ExportParams,
  type DocumentType,
} from "@transfer/domain";
import { createHash, randomBytes } from "node:crypto";
import { createRouter, json, type Deps } from "../context";
import { functionRefusal } from "../database-errors";
import {
  decryptDocument,
  DocumentCipherError,
  documentEncryptionKey,
} from "../document-encryption";
import { objectKey } from "../documents/files";
import { storageUnavailable } from "../documents/service";
import { errorForLog } from "../logger";
import { domainProblem, problem, problemResponses } from "../problem";
import { requireSession, sessionHash, sessionUser } from "../session";
import { auditContext } from "../sql";

// Exports (data-protection.md, exports; ADR-0010, exports; Q159): `POST /exports/{kind}` is the
// logged request (`export_created`) that answers a link valid 60 s for the asking session; the
// download re-authorizes the viewer and every included document (`export_link_content`), renders
// the output from the immutable generated forms at that moment, streams it and stores nothing, and
// is audited itself (`export_downloaded`). Logs carry ids, codes and counts only, never a token.

export function exportRoutes(deps: Deps) {
  const { db, env, logger } = deps;
  const router = createRouter();
  const key = documentEncryptionKey(env.documentEncryptionKey);

  router.openapi(
    createRoute({
      method: "post",
      path: "/exports/{kind}",
      tags: ["documents"],
      summary:
        "Issue an export (kug200b_print: one print file of 1–100 generated Kug 200b forms of one project the viewer may open), audited export_created; a same-origin link bound to this staff session, valid 60 s; no file is stored",
      description: [
        "Refusals:",
        "- `404` for a form that doesn't exist, is deleted or isn't a generated Kug 200b (each form must be the viewer's to open, else `403`).",
        "- `422 document_quarantined`; `422 invalid_argument` for forms of more than one project.",
      ].join("\n"),
      middleware: [requireSession(deps)],
      request: {
        params: ExportParams,
        body: { required: true, content: { "application/json": { schema: ExportInput } } },
      },
      responses: {
        201: json(ExportLink, "The link"),
        ...problemResponses(
          "validation-error",
          "unauthenticated",
          "forbidden",
          "not-found",
          "domain-error",
        ),
      },
    }),
    async (c) => {
      const { kind } = c.req.valid("param");
      const { documentIds } = c.req.valid("json");
      const token = randomBytes(32).toString("base64url");
      const linkHash = createHash("sha256").update(token).digest("hex");
      let expiresAt: string;
      try {
        const { rows } = await db.execute<{ result: string }>(sql`select to_char(
          create_export_link(p_context => ${auditContext(sessionUser(c).id, c.get("requestId"))},
            p_kind => ${kind}::export_kind, p_document_ids => ${`{${documentIds.join(",")}}`}::uuid[],
            p_session_hash => ${sessionHash(c)}, p_link_hash => ${linkHash})
          at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as result`);
        expiresAt = rows[0]!.result;
      } catch (error) {
        const code = functionRefusal(error);
        logger.info(
          { requestId: c.get("requestId"), exportKind: kind, outcome: code ?? "failed" },
          "export",
        );
        if (code === "session_invalid") return problem(c, "unauthenticated") as never;
        if (code === "actor_not_allowed") return problem(c, "forbidden") as never;
        if (code === "document_not_found") return problem(c, "not-found") as never;
        if (code === "document_quarantined" || code === "invalid_argument") {
          return domainProblem(c, [code]) as never;
        }
        throw error;
      }
      logger.info(
        { requestId: c.get("requestId"), exportKind: kind, count: documentIds.length },
        "export",
      );
      c.header("Cache-Control", "no-store");
      return c.json({ url: `/api/v1/export-content/${token}`, expiresAt }, 201);
    },
  );

  router.openapi(
    createRoute({
      method: "get",
      path: "/export-content/{token}",
      tags: ["documents"],
      summary:
        "The export of a link as an attachment (no-store, nosniff): only with the staff session that asked and within 60 s, else 404; every form re-authorized now (422 export_stale when one is no longer the viewer's, deleted or quarantined); rendered at the download, stored nowhere, audited export_downloaded",
      middleware: [requireSession(deps)],
      request: { params: ExportContentParams },
      responses: {
        200: {
          description: "The print file",
          content: { "application/pdf": { schema: z.string().meta({ format: "binary" }) } },
        },
        ...problemResponses(
          "validation-error",
          "unauthenticated",
          "not-found",
          "domain-error",
          "service-unavailable",
        ),
      },
    }),
    async (c) => {
      c.header("Cache-Control", "no-store");
      const hash = sessionHash(c);
      const staffUserId = sessionUser(c).id;
      const linkHash = createHash("sha256").update(c.req.valid("param").token).digest("hex");
      let rows: {
        document_id: string;
        participation_id: string;
        document_type: DocumentType;
        key_id: string;
        wrapped_key: Buffer;
      }[];
      try {
        ({ rows } = await db.execute(sql`select document_id, participation_id, document_type,
            key_id, wrapped_key
          from export_link_content(p_context => ${auditContext(staffUserId, c.get("requestId"))},
            p_link_hash => ${linkHash}, p_session_hash => ${hash})`));
      } catch (error) {
        const code = functionRefusal(error);
        if (code === "export_link_invalid") return problem(c, "not-found") as never;
        if (code === "export_stale") return domainProblem(c, [code]) as never;
        throw error;
      }
      const files = deps.documentFiles;
      if (!files) return storageUnavailable(c) as never;
      const parts: Uint8Array[] = [];
      for (const row of rows) {
        try {
          const object = await files.storage.get(objectKey(row.document_id));
          parts.push(
            decryptDocument(
              key,
              {
                documentId: row.document_id,
                participationId: row.participation_id,
                type: row.document_type,
              },
              { object, keyId: row.key_id, wrappedKey: new Uint8Array(row.wrapped_key) },
            ),
          );
        } catch (error) {
          if (!(error instanceof FileNotFound) && !(error instanceof DocumentCipherError)) {
            throw error;
          }
          // An object missing or not matching its row: never served, logged by its code only.
          logger.error(
            {
              requestId: c.get("requestId"),
              documentId: row.document_id,
              error: errorForLog(error),
            },
            "export content unavailable",
          );
          return problem(c, "internal-error", {
            instance: `urn:request:${c.get("requestId")}`,
          }) as never;
        }
      }
      const content = await mergePdfs(parts);
      logger.info(
        { requestId: c.get("requestId"), exportKind: "kug200b_print", count: rows.length },
        "export download",
      );
      const name = `kug200b-druck-${deps.clock.today()}.pdf`;
      return c.body(new Uint8Array(content), 200, {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${name}"`,
        "X-Content-Type-Options": "nosniff",
      }) as never;
    },
  );

  return router;
}
