import { createRoute, z } from "@hono/zod-openapi";
import { berlinDate } from "@transfer/adapters";
import { eq, participation, sql } from "@transfer/db";
import {
  AssistedModeQuery,
  DocumentContentParams,
  DocumentDeleteQuery,
  DocumentList,
  DocumentOpening,
  DocumentReviewInput,
  DocumentUploadInput,
  DocumentView,
  documentsHidden,
  downloadFileName,
  type DocumentMediaType,
  type DocumentType,
} from "@transfer/domain";
import type { Context } from "hono";
import { createHash } from "node:crypto";
import { projectAccess } from "../access";
import { createRouter, json, type AppEnv, type Deps } from "../context";
import {
  decryptDocument,
  DocumentCipherError,
  documentEncryptionKey,
} from "../document-encryption";
import { objectKey } from "../documents/files";
import { documentService, storageUnavailable, type DocumentActor } from "../documents/service";
import { FileNotFound } from "@transfer/adapters";
import { errorForLog } from "../logger";
import { portalSession, portalTokenHash, requirePortalSession } from "../portal-session";
import { problem, problemResponses } from "../problem";
import { cookieTokenHash, requireSession, sessionHash, sessionUser } from "../session";
import { assistedContext, auditContext, participantContext } from "../sql";
import { assistedModeRequired, liveAssistedMode } from "./assisted-mode";

// The documents API (ADR-0010, uploads and documents; data-protection.md, uploads; Q142–Q148):
// the participant's own in the portal, staff in normal mode on the participation, staff in
// assisted mode on the wizard's page, and the download behind an opening's link. A document of
// another participation is a 404, like a participation the viewer can't see (an unassigned
// consultant too).

const ParticipationParams = z.object({ participationId: z.uuid() });
const DocumentParams = z.object({ documentId: z.uuid() });
const ParticipationDocumentParams = z.object({ participationId: z.uuid(), documentId: z.uuid() });

const uploadBody = {
  required: true,
  content: { "application/json": { schema: DocumentUploadInput } },
} as const;

/** The upload routes' problems; 503 `upload_busy`, `scan_unavailable`, `storage_unavailable`. */
const uploadProblems = {
  ...problemResponses(
    "validation-error",
    "unauthenticated",
    "forbidden",
    "not-found",
    "payload-too-large",
    "domain-error",
    "too-many-requests",
  ),
  503: {
    ...problemResponses("service-unavailable")[503],
    headers: z.object({
      "Retry-After": z.string().meta({ description: "Seconds after which a retry may succeed" }),
    }),
  },
};
const openingProblems = problemResponses(
  "validation-error",
  "unauthenticated",
  "forbidden",
  "not-found",
  "service-unavailable",
);

const binary = z.string().meta({ format: "binary" });
const download = Object.fromEntries(
  ["application/pdf", "image/jpeg", "image/png"].map((type) => [type, { schema: binary }]),
);

/** `attachment` with an ASCII fallback and the UTF-8 name (RFC 6266); quotes and controls replaced. */
function contentDisposition(name: string) {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** The participant in the portal, on their own participation. */
function portalActor(c: Context<AppEnv>): DocumentActor {
  const session = portalSession(c);
  const { participationId, projectId, tokenHash } = session;
  return {
    subject: { kind: "participant", participationId, knowledgeCheckPassed: false },
    target: { projectId, regionId: null, participationId },
    mode: { kind: "normal" },
    context: participantContext(participationId, c.get("requestId")),
    session: { kind: "participant", hash: tokenHash },
    tokenHash,
  };
}

export function documentRoutes(deps: Deps) {
  const { db, env, logger } = deps;
  const router = createRouter();
  const service = documentService(deps);
  const key = documentEncryptionKey(env.documentEncryptionKey);
  const portal = [requirePortalSession(deps, "active")];
  const staff = [requireSession(deps)];

  /** The staff actor in normal or assisted mode, else the problem to answer. */
  async function staffActor(
    c: Context<AppEnv>,
    participationId: string,
    assistedModeId?: string,
  ): Promise<{ actor: DocumentActor } | { response: Response }> {
    const user = sessionUser(c);
    const [found] = await db
      .select({ projectId: participation.projectId })
      .from(participation)
      .where(eq(participation.id, participationId));
    if (!found) return { response: problem(c, "not-found") };
    const { subject, visible, regionId } = await projectAccess(db, user, found.projectId);
    const target = { projectId: found.projectId, regionId, participationId };
    if (!visible || documentsHidden(subject, target)) return { response: problem(c, "not-found") };
    const hash = sessionHash(c);
    const requestId = c.get("requestId");
    if (assistedModeId === undefined) {
      const context = auditContext(user.id, requestId);
      const mode = { kind: "normal" } as const;
      return {
        actor: {
          subject,
          target,
          mode,
          context,
          session: { kind: "staff", hash },
          tokenHash: null,
        },
      };
    }
    if (!(await liveAssistedMode(db, assistedModeId, participationId, hash))) {
      return { response: assistedModeRequired(c) };
    }
    return {
      actor: {
        subject,
        target,
        mode: { kind: "assisted", onBehalfOf: participationId },
        context: assistedContext(user.id, participationId, requestId),
        session: { kind: "staff", hash },
        tokenHash: hash,
      },
    };
  }

  // The portal: the participant's own documents of the types they may read.

  router.openapi(
    createRoute({
      method: "get",
      path: "/portal/documents",
      tags: ["portal"],
      summary:
        "The participant's own live documents (metadata, capabilities), the types they may add and the limits",
      middleware: portal,
      responses: {
        200: json(DocumentList, "The documents, oldest first"),
        ...problemResponses("unauthenticated"),
      },
    }),
    async (c) => {
      c.header("Cache-Control", "no-store");
      return c.json(await service.list(portalActor(c)), 200);
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/portal/documents",
      tags: ["portal"],
      summary:
        "Upload a document (base64, at most 10 MB; PDF, JPEG or PNG by content); scanned before it is stored, encrypted, audited (document_added)",
      middleware: portal,
      request: { body: uploadBody },
      responses: { 201: json(DocumentView, "Stored"), ...uploadProblems },
    }),
    async (c) => service.upload(c, portalActor(c), c.req.valid("json")) as never,
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/portal/documents/{documentId}/opening",
      tags: ["portal"],
      summary:
        "Open a document: audited (document_opened); a same-origin link bound to this session, valid 60 s",
      middleware: portal,
      request: { params: DocumentParams },
      responses: { 201: json(DocumentOpening, "The link"), ...openingProblems },
    }),
    async (c) => service.open(c, portalActor(c), c.req.valid("param").documentId) as never,
  );

  router.openapi(
    createRoute({
      method: "delete",
      path: "/portal/documents/{documentId}",
      tags: ["portal"],
      summary:
        "Delete an own upload while not accepted (document_accepted otherwise); the file is purged, the row kept as a tombstone",
      middleware: portal,
      request: { params: DocumentParams },
      responses: {
        204: { description: "Deleted" },
        ...problemResponses(
          "validation-error",
          "unauthenticated",
          "forbidden",
          "not-found",
          "domain-error",
        ),
      },
    }),
    async (c) => service.remove(c, portalActor(c), c.req.valid("param").documentId, null) as never,
  );

  // Staff in normal mode, on the participation.

  router.openapi(
    createRoute({
      method: "get",
      path: "/participations/{participationId}/documents",
      tags: ["participations"],
      summary:
        "The participation's live documents of the types the viewer may read, with capabilities, the types they may add and the limits",
      middleware: staff,
      request: { params: ParticipationParams },
      responses: {
        200: json(DocumentList, "The documents, oldest first"),
        ...problemResponses("validation-error", "unauthenticated", "not-found"),
      },
    }),
    async (c) => {
      const found = await staffActor(c, c.req.valid("param").participationId);
      if ("response" in found) return found.response as never;
      c.header("Cache-Control", "no-store");
      return c.json(await service.list(found.actor), 200);
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/participations/{participationId}/documents",
      tags: ["participations"],
      summary:
        "Upload a document as yourself (normal mode), e.g. one handed over on paper; as the portal upload",
      middleware: staff,
      request: { params: ParticipationParams, body: uploadBody },
      responses: { 201: json(DocumentView, "Stored"), ...uploadProblems },
    }),
    async (c) => {
      const found = await staffActor(c, c.req.valid("param").participationId);
      if ("response" in found) return found.response as never;
      return service.upload(c, found.actor, c.req.valid("json")) as never;
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/participations/{participationId}/documents/{documentId}/opening",
      tags: ["participations"],
      summary:
        "Open a document: audited (document_opened); a same-origin link bound to this staff session, valid 60 s",
      middleware: staff,
      request: { params: ParticipationDocumentParams },
      responses: { 201: json(DocumentOpening, "The link"), ...openingProblems },
    }),
    async (c) => {
      const { participationId, documentId } = c.req.valid("param");
      const found = await staffActor(c, participationId);
      if ("response" in found) return found.response as never;
      return service.open(c, found.actor, documentId) as never;
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/participations/{participationId}/documents/{documentId}/review",
      tags: ["participations"],
      summary:
        "Accept, or reject with a reason code; once and final (document_reviewed otherwise), audited",
      middleware: staff,
      request: {
        params: ParticipationDocumentParams,
        body: {
          required: true,
          content: { "application/json": { schema: DocumentReviewInput } },
        },
      },
      responses: {
        200: json(DocumentView, "Reviewed"),
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
      const { participationId, documentId } = c.req.valid("param");
      const found = await staffActor(c, participationId);
      if ("response" in found) return found.response as never;
      return service.review(c, found.actor, documentId, c.req.valid("json")) as never;
    },
  );

  router.openapi(
    createRoute({
      method: "delete",
      path: "/participations/{participationId}/documents/{documentId}",
      tags: ["participations"],
      summary:
        "Delete a document with a reason code (also after a terminal status); the file is purged, the row kept as a tombstone, audited",
      middleware: staff,
      request: { params: ParticipationDocumentParams, query: DocumentDeleteQuery },
      responses: {
        204: { description: "Deleted" },
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
      const { participationId, documentId } = c.req.valid("param");
      const found = await staffActor(c, participationId);
      if ("response" in found) return found.response as never;
      const { reasonCode } = c.req.valid("query");
      return service.remove(c, found.actor, documentId, reasonCode) as never;
    },
  );

  // Staff in assisted mode: the wizard's page lists, adds on the participant's behalf and opens.

  router.openapi(
    createRoute({
      method: "get",
      path: "/participations/{participationId}/assisted/documents",
      tags: ["participations"],
      summary:
        "The documents as the role sees them in assisted mode; 403 assisted_mode_required without a live mode of this session",
      middleware: staff,
      request: { params: ParticipationParams, query: AssistedModeQuery },
      responses: {
        200: json(DocumentList, "The documents, oldest first"),
        ...problemResponses("validation-error", "unauthenticated", "forbidden", "not-found"),
      },
    }),
    async (c) => {
      const { participationId } = c.req.valid("param");
      const found = await staffActor(c, participationId, c.req.valid("query").assistedModeId);
      if ("response" in found) return found.response as never;
      c.header("Cache-Control", "no-store");
      return c.json(await service.list(found.actor), 200);
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/participations/{participationId}/assisted/documents",
      tags: ["participations"],
      summary: "Upload a document on the participant's behalf (actor and onBehalfOf)",
      middleware: staff,
      request: { params: ParticipationParams, query: AssistedModeQuery, body: uploadBody },
      responses: { 201: json(DocumentView, "Stored"), ...uploadProblems },
    }),
    async (c) => {
      const { participationId } = c.req.valid("param");
      const found = await staffActor(c, participationId, c.req.valid("query").assistedModeId);
      if ("response" in found) return found.response as never;
      return service.upload(c, found.actor, c.req.valid("json")) as never;
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/participations/{participationId}/assisted/documents/{documentId}/opening",
      tags: ["participations"],
      summary:
        "Open a document in assisted mode (actor and onBehalfOf), audited; a link bound to this staff session",
      middleware: staff,
      request: { params: ParticipationDocumentParams, query: AssistedModeQuery },
      responses: { 201: json(DocumentOpening, "The link"), ...openingProblems },
    }),
    async (c) => {
      const { participationId, documentId } = c.req.valid("param");
      const found = await staffActor(c, participationId, c.req.valid("query").assistedModeId);
      if ("response" in found) return found.response as never;
      return service.open(c, found.actor, documentId) as never;
    },
  );

  // The download (Q147): the browser navigates here with the session that opened it.

  /** The link's document for the request's portal or staff session, if it is live. */
  async function linked(c: Context<AppEnv>, linkHash: string) {
    const sessions = [
      ["participant", portalTokenHash(c, env)],
      ["staff", cookieTokenHash(c, env)],
    ] as const;
    for (const [kind, hash] of sessions) {
      if (hash === null) continue;
      const { rows } = await db.execute<{
        document_id: string;
        participation_id: string;
        document_type: DocumentType;
        media_type: DocumentMediaType;
        file_name: string | null;
        key_id: string;
        wrapped_key: Buffer;
        added_at: string;
      }>(sql`select document_id, participation_id, document_type, media_type, file_name, key_id,
          wrapped_key, to_char(added_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as added_at
        from document_link_content(p_link_hash => ${linkHash},
          p_session_kind => ${kind}::document_session_kind, p_session_hash => ${hash})`);
      if (rows[0]) return rows[0];
    }
    return undefined;
  }

  router.openapi(
    createRoute({
      method: "get",
      path: "/document-content/{token}",
      tags: ["documents"],
      summary:
        "The file of an opening's link, as an attachment (no-store, nosniff, sandboxed); only with the session that opened it and within 60 s, else 404",
      request: { params: DocumentContentParams },
      responses: {
        200: { description: "The file", content: download },
        ...problemResponses("validation-error", "not-found", "service-unavailable"),
      },
    }),
    async (c) => {
      c.header("Cache-Control", "no-store");
      const linkHash = createHash("sha256").update(c.req.valid("param").token).digest("hex");
      const found = await linked(c, linkHash);
      if (!found) return problem(c, "not-found") as never;
      const files = deps.documentFiles;
      if (!files) return storageUnavailable(c) as never;
      let content: Uint8Array;
      try {
        const object = await files.storage.get(objectKey(found.document_id));
        content = decryptDocument(
          key,
          {
            documentId: found.document_id,
            participationId: found.participation_id,
            type: found.document_type,
          },
          { object, keyId: found.key_id, wrappedKey: new Uint8Array(found.wrapped_key) },
        );
      } catch (error) {
        if (!(error instanceof FileNotFound) && !(error instanceof DocumentCipherError)) {
          throw error;
        }
        // An object missing or not matching its row: never served, logged by its code only.
        logger.error(
          {
            requestId: c.get("requestId"),
            documentId: found.document_id,
            error: errorForLog(error),
          },
          "document content unavailable",
        );
        return problem(c, "internal-error", {
          instance: `urn:request:${c.get("requestId")}`,
        }) as never;
      }
      const name = downloadFileName(
        found.file_name,
        found.document_type,
        berlinDate(new Date(found.added_at)),
        found.media_type,
      );
      return c.body(new Uint8Array(content), 200, {
        "Content-Type": found.media_type,
        "Content-Disposition": contentDisposition(name),
        "X-Content-Type-Options": "nosniff",
      }) as never;
    },
  );

  return router;
}
