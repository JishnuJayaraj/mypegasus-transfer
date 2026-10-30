import { createRoute, z } from "@hono/zod-openapi";
import {
  createPdfRenderer,
  CsvExporter,
  FileNotFound,
  mergePdfs,
  type PdfRenderer,
} from "@transfer/adapters";
import { configDirs, loadOrganisation } from "@transfer/config/load";
import { eq, kug200bBatch, sql, type Database } from "@transfer/db";
import {
  ExportContentParams,
  ExportInput,
  ExportLink,
  ExportParams,
  isBatchExportKind,
  isOfficialExportKind,
  mayWorkKug200bBatches,
  type DocumentType,
  type ExportKind,
  type Kug200bBatchArtifact,
  type OfficialExportKind,
} from "@transfer/domain";
import { createHash, randomBytes } from "node:crypto";
import type { Context } from "hono";
import { createRouter, json, type AppEnv, type Deps } from "../context";
import { functionRefusal } from "../database-errors";
import {
  decryptDocument,
  DocumentCipherError,
  documentEncryptionKey,
} from "../document-encryption";
import { objectKey } from "../documents/files";
import { fieldEncryptionKey } from "../field-encryption";
import {
  kug200aOrganisationFingerprint,
  kug200aSourceOf,
  renderArtifact,
  scansPdf,
  type BatchPrintSources,
} from "../forms/kug200a";
import { formRegistry } from "../forms/registry";
import { projectAccess } from "../access";
import { agenturBatchSettings, settingsArgs } from "../participations/kug200b-batches";
import { loadRelease } from "../projects/template-pins";
import { batchRefused } from "./kug200b-batches";
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
// A batch's kinds name an open Kug 200b batch of the PL: rechecked at the request under the
// project's exclusive lock with the Agentur's settings resolved under it (process-and-lifecycle.md,
// Kug 200b batches; D24, D25), re-authorized at the download. The internal index's download
// checks the PL and the members; an official artifact's (the Kug 200a or the accepted alternative,
// the scans) is rechecked in full, settings included, in two steps under the lock: the read, then
// after rendering the record, which compares the fingerprint of everything printed (Q203 (6)).

/** What `read_kug200b_batch_export` returns. */
type OfficialRead = {
  kind: OfficialExportKind;
  channel: string;
  artifact: Kug200bBatchArtifact;
  fingerprint: string;
  sources: BatchPrintSources;
  /** The Kug 200a's: each recorded RV-Nummer by participation. */
  insuranceNumbers: Record<string, string> | null;
  /** The scans': each member's scan with its key material, in the list's order. */
  files:
    | {
        documentId: string;
        participationId: string;
        type: DocumentType;
        mediaType: string;
        keyId: string;
        wrappedKey: string;
      }[]
    | null;
};

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** The operational index (the PL's work list): never the artifact sent to the Agentur. */
const indexColumns = [
  { key: "lastName", label: "Nachname" },
  { key: "firstName", label: "Vorname" },
  { key: "formVersion", label: "Formularversion" },
] as const;

export function exportRoutes(deps: Deps) {
  const { db, env, logger, clock } = deps;
  const router = createRouter();
  const key = documentEncryptionKey(env.documentEncryptionKey);
  const release = loadRelease(env.configDir);
  const registry = deps.formRegistry ?? formRegistry(env.configDir);
  const exporter = new CsvExporter();
  const fieldKey = fieldEncryptionKey(env.fieldEncryptionKey!);
  const company = loadOrganisation(configDirs(env.configDir).organisation).transfergesellschaft;
  const organisationSha256 = kug200aOrganisationFingerprint(company);
  let renderer: PdfRenderer | undefined;
  // The adapter `PDF_ADAPTER` selects, with the registry's font, built on the first artifact.
  const pdf = () =>
    (renderer ??=
      deps.pdfRenderer ??
      createPdfRenderer({
        adapter: env.pdfAdapter,
        gotenbergUrl: env.gotenbergUrl,
        production: env.nodeEnv === "production",
        font: registry.font(),
      }));

  /**
   * A batch's export link (D24): the batch hidden (404) from anyone but its PL whatever its state,
   * then rechecked under the project's exclusive lock (`batch_stale` with the rows).
   */
  async function batchExport(c: Context<AppEnv>, kind: ExportKind, batchId: string) {
    const [batch] = await db
      .select({ projectId: kug200bBatch.projectId, agenturKey: kug200bBatch.agenturKey })
      .from(kug200bBatch)
      .where(eq(kug200bBatch.id, batchId));
    const access = batch && (await projectAccess(db, sessionUser(c), batch.projectId));
    if (
      !batch ||
      !access?.visible ||
      !mayWorkKug200bBatches(access.subject, {
        projectId: batch.projectId,
        regionId: access.regionId,
        participationId: null,
      }).ok
    ) {
      return problem(c, "not-found");
    }
    const token = randomBytes(32).toString("base64url");
    const linkHash = createHash("sha256").update(token).digest("hex");
    let expiresAt: string;
    try {
      expiresAt = await db.transaction(async (tx) => {
        await tx.execute(sql`select lock_project_setup(${batch.projectId}::uuid)`);
        const settings = settingsArgs(
          await agenturBatchSettings(
            tx,
            release,
            registry,
            batch.projectId,
            batch.agenturKey,
            clock.today(),
          ),
        );
        const { rows } = await tx.execute<{ result: string }>(sql`select to_char(
          create_kug200b_batch_export_link(p_context => ${auditContext(sessionUser(c).id, c.get("requestId"))},
            p_kind => ${kind}::export_kind, p_batch_id => ${batchId}::uuid,
            p_session_hash => ${sessionHash(c)}, p_link_hash => ${linkHash},
            p_channel => ${settings.channel}::kug200b_batch_channel,
            p_artifact => ${settings.artifact}::kug200b_batch_artifact,
            p_outdated_versions => ${settings.outdatedVersions}::text[])
          at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as result`);
        return rows[0]!.result;
      });
    } catch (error) {
      logger.info(
        {
          requestId: c.get("requestId"),
          exportKind: kind,
          outcome: functionRefusal(error) ?? "failed",
        },
        "export",
      );
      return batchRefused(c, error, "batch");
    }
    logger.info({ requestId: c.get("requestId"), exportKind: kind, batchId }, "export");
    c.header("Cache-Control", "no-store");
    return c.json({ url: `/api/v1/export-content/${token}`, expiresAt }, 201);
  }

  /** A batch's index at the download: re-authorized and read in one locked call, a CSV. */
  async function batchIndex(c: Context<AppEnv>, linkHash: string) {
    let rows: { last_name: string | null; first_name: string | null; form_version: string }[];
    try {
      ({ rows } = await db.execute(sql`select last_name, first_name, form_version
        from kug200b_batch_export_content(
          p_context => ${auditContext(sessionUser(c).id, c.get("requestId"))},
          p_link_hash => ${linkHash}, p_session_hash => ${sessionHash(c)})`));
    } catch (error) {
      const code = functionRefusal(error);
      if (code === "export_link_invalid") return problem(c, "not-found");
      if (code === "export_stale") return domainProblem(c, [code]);
      throw error;
    }
    const file = exporter.export({
      kind: "kug200b-arbeitsliste",
      version: 1,
      columns: indexColumns,
      rows: rows.map((row) => ({
        lastName: row.last_name,
        firstName: row.first_name,
        formVersion: row.form_version,
      })),
    });
    logger.info(
      { requestId: c.get("requestId"), exportKind: "kug200b_batch_index", count: rows.length },
      "export download",
    );
    return c.body(new Uint8Array(file.content), 200, {
      "Content-Type": file.contentType,
      "Content-Disposition": `attachment; filename="kug200b-arbeitsliste-${clock.today()}.csv"`,
      "X-Content-Type-Options": "nosniff",
    });
  }

  /** An official download's refusal: hidden 404, stale 422, moved since the read 409. */
  function officialRefused(c: Context<AppEnv>, error: unknown, kind: ExportKind) {
    const code = functionRefusal(error);
    logger.info(
      { requestId: c.get("requestId"), exportKind: kind, outcome: code ?? "failed" },
      "export download",
    );
    if (code === "export_link_invalid") return problem(c, "not-found");
    if (code === "export_stale") return domainProblem(c, [code]);
    if (code === "source_changed") {
      return problem(c, "conflict", {
        errors: [
          { pointer: "", code, detail: "Something printed changed meanwhile; download again" },
        ],
      });
    }
    throw error;
  }

  /**
   * An official artifact's download (Q203 (6)): the link's batch, then under the project's
   * exclusive lock the Agentur's settings resolved now and `read_kug200b_batch_export` (the full
   * recheck, the values, the RV-Nummern each audited); the file rendered; then under the lock
   * again `record_kug200b_batch_export` (the full recheck, the fingerprint, `export_downloaded`).
   * Streamed, stored nowhere.
   */
  async function officialDownload(c: Context<AppEnv>, kind: ExportKind, linkHash: string) {
    const context = auditContext(sessionUser(c).id, c.get("requestId"));
    const session = sessionHash(c);
    let batchId: string;
    try {
      const { rows } = await db.execute<{ id: string }>(sql`select export_link_batch(
        p_context => ${context}, p_link_hash => ${linkHash}, p_session_hash => ${session}) as id`);
      batchId = rows[0]!.id;
    } catch (error) {
      return officialRefused(c, error, kind);
    }
    const [batch] = await db
      .select({ projectId: kug200bBatch.projectId, agenturKey: kug200bBatch.agenturKey })
      .from(kug200bBatch)
      .where(eq(kug200bBatch.id, batchId));
    /** Runs `step` under the project's exclusive lock with the settings resolved under it. */
    const locked = <T>(step: (tx: Tx, settings: ReturnType<typeof settingsArgs>) => Promise<T>) =>
      db.transaction(async (tx) => {
        await tx.execute(sql`select lock_project_setup(${batch!.projectId}::uuid)`);
        const resolved = await agenturBatchSettings(
          tx,
          release,
          registry,
          batch!.projectId,
          batch!.agenturKey,
          clock.today(),
        );
        return step(tx, settingsArgs(resolved));
      });
    let found: OfficialRead;
    try {
      found = await locked(async (tx, settings) => {
        const { rows } = await tx.execute<{ result: OfficialRead }>(sql`select
          read_kug200b_batch_export(p_context => ${context}, p_link_hash => ${linkHash},
            p_session_hash => ${session},
            p_channel => ${settings.channel}::kug200b_batch_channel,
            p_artifact => ${settings.artifact}::kug200b_batch_artifact,
            p_outdated_versions => ${settings.outdatedVersions}::text[],
            p_organisation_sha256 => ${organisationSha256},
            p_key => ${fieldKey.key}, p_key_id => ${fieldKey.keyId}) as result`);
        return rows[0]!.result;
      });
    } catch (error) {
      return officialRefused(c, error, kind);
    }
    const today = clock.today();
    let content: Uint8Array;
    let fileName: string;
    if (found.kind === "kug200b_batch_scans") {
      const files = deps.documentFiles;
      if (!files) return storageUnavailable(c);
      const parts: { content: Uint8Array; mediaType: string }[] = [];
      for (const file of found.files ?? []) {
        try {
          const object = await files.storage.get(objectKey(file.documentId));
          parts.push({
            mediaType: file.mediaType,
            content: decryptDocument(
              key,
              {
                documentId: file.documentId,
                participationId: file.participationId,
                type: file.type,
              },
              {
                object,
                keyId: file.keyId,
                wrappedKey: new Uint8Array(Buffer.from(file.wrappedKey, "base64")),
              },
            ),
          });
        } catch (error) {
          if (!(error instanceof FileNotFound) && !(error instanceof DocumentCipherError)) {
            throw error;
          }
          // An object missing or not matching its row: never served, logged by its code only.
          logger.error(
            {
              requestId: c.get("requestId"),
              documentId: file.documentId,
              error: errorForLog(error),
            },
            "export content unavailable",
          );
          return problem(c, "internal-error", { instance: `urn:request:${c.get("requestId")}` });
        }
      }
      content = await scansPdf(parts);
      fileName = `kug200b-scans-${today}.pdf`;
    } else {
      const numbers = found.insuranceNumbers ?? {};
      const outcome = await renderArtifact(
        registry,
        pdf(),
        kug200aSourceOf(found.sources, company, (m) => numbers[m.participationId] ?? null),
        found.artifact,
        { today, createdOn: found.sources.createdOn },
      );
      if (!outcome.ok) {
        logger.info(
          { requestId: c.get("requestId"), exportKind: kind, outcome: outcome.code },
          "export download",
        );
        if (outcome.code === "form_version_unavailable") return domainProblem(c, [outcome.code]);
        return problem(c, "service-unavailable", {
          errors: [
            { pointer: "", code: outcome.code, detail: "Not available now; try again later" },
          ],
        });
      }
      ({ content, fileName } = outcome);
    }
    try {
      await locked((tx, settings) =>
        tx.execute(sql`select record_kug200b_batch_export(p_context => ${context},
          p_link_hash => ${linkHash}, p_session_hash => ${session},
          p_channel => ${settings.channel}::kug200b_batch_channel,
          p_artifact => ${settings.artifact}::kug200b_batch_artifact,
          p_outdated_versions => ${settings.outdatedVersions}::text[],
          p_organisation_sha256 => ${organisationSha256},
          p_fingerprint => ${found.fingerprint})`),
      );
    } catch (error) {
      return officialRefused(c, error, kind);
    }
    logger.info(
      { requestId: c.get("requestId"), exportKind: kind, count: found.sources.members.length },
      "export download",
    );
    return c.body(new Uint8Array(content), 200, {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "X-Content-Type-Options": "nosniff",
    });
  }

  router.openapi(
    createRoute({
      method: "post",
      path: "/exports/{kind}",
      tags: ["documents"],
      summary:
        "Issue an export (kug200b_print: one print file of 1–100 generated Kug 200b forms of one project the viewer may open; of an open Kug 200b batch, its PL only: kug200b_batch_index its work list, kug200b_batch_artifact the Kug 200a or the accepted alternative list, kug200b_batch_scans the members' scans for the channels scan_email and upload), audited export_created; a same-origin link bound to this staff session, valid 60 s; no file is stored",
      description: [
        "Refusals:",
        "- `404` for a form that doesn't exist, is deleted, isn't a generated Kug 200b or isn't the viewer's to open, and for a batch the viewer doesn't lead, whatever its state.",
        "- `403` in assisted mode.",
        "- Only for forms the viewer sees: `422 document_quarantined`, `422 document_invalidated`; `422 invalid_argument` for forms of more than one project or a body of another kind.",
        "- Only for a batch the viewer leads: `422 batch_not_open`; `422 batch_stale` with `staleRows`; `422 export_not_applicable` for the scans of a paper channel (the Kug 200a goes with the originals).",
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
      const input = c.req.valid("json");
      if (isBatchExportKind(kind) !== "batchId" in input) {
        return domainProblem(c, ["invalid_argument"]) as never;
      }
      if ("batchId" in input) return (await batchExport(c, kind, input.batchId)) as never;
      const { documentIds } = input;
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
        if (
          code === "document_quarantined" ||
          code === "document_invalidated" ||
          code === "invalid_argument"
        ) {
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
        "The export of a link as an attachment (no-store, nosniff, the download policy): only with the staff session that asked and within 60 s, else 404; every form or batch member re-authorized now (422 export_stale when one is no longer the viewer's, deleted or quarantined, or a member moved; an official artifact also when the Agentur's settings changed); an official artifact's sources compared again after rendering (409 source_changed); 422 form_version_unavailable without a Kug 200a in use; 503 pdf_unavailable for the alternative list without an HTML renderer; rendered at the download, stored nowhere, audited export_downloaded",
      middleware: [requireSession(deps)],
      request: { params: ExportContentParams },
      responses: {
        200: {
          description:
            "The print file, a batch's work list, its Kug 200a or alternative list, or its scans",
          content: {
            "application/pdf": { schema: z.string().meta({ format: "binary" }) },
            "text/csv": { schema: z.string().meta({ format: "binary" }) },
          },
        },
        ...problemResponses(
          "validation-error",
          "unauthenticated",
          "not-found",
          "conflict",
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
      let kind: ExportKind;
      try {
        const { rows: found } = await db.execute<{ kind: ExportKind }>(sql`select
          export_link_kind(p_context => ${auditContext(staffUserId, c.get("requestId"))},
            p_link_hash => ${linkHash}, p_session_hash => ${hash}) as kind`);
        kind = found[0]!.kind;
      } catch (error) {
        if (functionRefusal(error) === "export_link_invalid")
          return problem(c, "not-found") as never;
        throw error;
      }
      if (isOfficialExportKind(kind)) {
        return (await officialDownload(c, kind, linkHash)) as never;
      }
      if (isBatchExportKind(kind)) return (await batchIndex(c, linkHash)) as never;
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
