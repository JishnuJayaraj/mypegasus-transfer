import { ScannerUnavailable } from "@transfer/adapters";
import { and, asc, document, eq, inArray, isNull, sql, transactionWithClient } from "@transfer/db";
import {
  detectFileType,
  documentCapabilities,
  documentDeleteReasons,
  documentFileName,
  documentLimits,
  documentTypeEntry,
  kug200bScanReviewProblems,
  mayAddDocument,
  mayDeleteDocument,
  mayLiftDocumentQuarantine,
  mayQuarantineDocument,
  mayReviewDocument,
  readableDocumentTypes,
  scanForms,
  scanReviewProblems,
  scanUploadProblems,
  uploadableDocumentTypes,
  addableDocumentTypes,
  type AccessMode,
  type DocumentDeleteReason,
  type DocumentList,
  type DocumentMediaType,
  type DocumentReviewReason,
  type DocumentReviewState,
  type DocumentType,
  type DocumentPermission,
  type DocumentReviewInput,
  type DocumentTarget,
  type DocumentUploadInput,
  type DocumentView,
  type QuarantineReason,
  type ScanOrigin,
  type Subject,
} from "@transfer/domain";
import type { SQL } from "drizzle-orm";
import type { Context } from "hono";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { AppEnv, Deps } from "../context";
import { functionRefusal } from "../database-errors";
import { documentEncryptionKey, encryptDocument } from "../document-encryption";
import { ImportBusyError, uploadSlots } from "../imports/slots";
import { errorForLog } from "../logger";
import { domainProblem, problem } from "../problem";
import { assistedModeRequired } from "../routes/assisted-mode";
import { formRegistry } from "../forms/registry";
import { utc } from "../sql";
import { objectKey } from "./files";
import { purgeDocumentObject } from "./purge";

// The documents of one participation for one actor (data-protection.md, uploads and documents;
// Q142–Q148): the routes build the actor (portal, staff in normal mode, assisted mode), this does
// the rest. The access matrix and the document permissions decide first; the document functions
// check the same again under the participation lock. Nothing here logs or answers a file name,
// content, hash, token or key.

/** Who acts on a participation's documents, in which mode, and through which session. */
export type DocumentActor = {
  subject: Subject;
  target: DocumentTarget;
  mode: AccessMode;
  /** The `audit_context` of the calls. */
  context: SQL;
  /** The session the opening binds its link to, and the functions check. */
  session: { kind: "participant" | "staff"; hash: string };
  /** What the functions take as `p_token_hash`: the portal session, or the staff session in assisted mode. */
  tokenHash: string | null;
};

const selected = {
  id: document.id,
  type: document.type,
  mediaType: document.mediaType,
  sizeBytes: document.sizeBytes,
  fileName: document.fileName,
  addedAt: utc(document.addedAt),
  addedBy: document.addedBy,
  onBehalf: document.addedOnBehalf,
  reviewState: document.reviewState,
  reviewReason: document.reviewReason,
  reviewedAt: utc(document.reviewedAt),
  quarantineReason: document.quarantineReason,
  quarantinedBy: document.quarantinedBy,
  quarantinedAt: utc(document.quarantinedAt),
  scanOrigin: document.scanOrigin,
  generationDocumentId: document.generationDocumentId,
  formVersion: document.formVersion,
  signedOn: document.signedOn,
  countersignedOn: document.countersignedOn,
};
type Row = {
  id: string;
  type: DocumentType;
  mediaType: DocumentMediaType;
  sizeBytes: number;
  fileName: string | null;
  addedAt: string;
  addedBy: "user" | "participant" | "system";
  onBehalf: boolean;
  reviewState: DocumentReviewState;
  reviewReason: DocumentReviewReason | null;
  reviewedAt: string | null;
  quarantineReason: QuarantineReason | null;
  quarantinedBy: string | null;
  quarantinedAt: string | null;
  scanOrigin: ScanOrigin | null;
  generationDocumentId: string | null;
  formVersion: string | null;
  signedOn: string | null;
  countersignedOn: string | null;
};

/** Log a size by its bucket only (data-protection.md, uploads as built). */
function sizeBucket(bytes: number) {
  const mb = 1024 * 1024;
  if (bytes < 100 * 1024) return "<100k";
  if (bytes < mb) return "<1m";
  if (bytes < 5 * mb) return "<5m";
  return "<=10m";
}

const busy = (c: Context<AppEnv>, code: string, retryAfter?: number) => {
  if (retryAfter !== undefined) c.header("Retry-After", String(retryAfter));
  return problem(c, "service-unavailable", {
    errors: [{ pointer: "", code, detail: "Not available now; try again later" }],
  });
};

/** 503 while no store or scanner is wired (production before the pilot, Q149). */
export const storageUnavailable = (c: Context<AppEnv>) => busy(c, "storage_unavailable");

/** A permission's denial as its problem: 422 for an accepted or immutable document, else 403. */
function denied(c: Context<AppEnv>, permission: Exclude<DocumentPermission, { ok: true }>) {
  if (permission.because === "document_accepted") return domainProblem(c, ["document_accepted"]);
  if (permission.because === "immutable") return domainProblem(c, ["document_immutable"]);
  return problem(c, "forbidden");
}

/** A refusal of the document functions as its problem, or rethrown. */
function refused(c: Context<AppEnv>, error: unknown) {
  const code = functionRefusal(error);
  switch (code) {
    case "session_invalid":
      return problem(c, "unauthenticated");
    case "assisted_mode_required":
      return assistedModeRequired(c);
    case "actor_not_allowed":
    case "invalid_actor":
      return problem(c, "forbidden");
    case "document_not_found":
      return problem(c, "not-found");
    case "upload_rate_limited":
      c.header("Retry-After", "3600");
      return problem(c, "too-many-requests", {
        errors: [{ pointer: "", code: "rate_limited", detail: "Please try again later" }],
      });
    case "participation_closed":
    case "document_type_not_supported":
    case "document_limit":
    case "document_reviewed":
    case "document_accepted":
    case "document_immutable":
    case "document_quarantined":
    case "document_not_quarantined":
    case "delete_reason_not_allowed":
    case "signature_in_future":
    case "signature_before_generation":
      return domainProblem(c, [code]);
    case "generation_not_found":
      return domainProblem(c, [{ code, field: "generationDocumentId" }]);
    default:
      throw error;
  }
}

/** What the actor may do with a row now. */
export function capabilitiesOf(actor: DocumentActor, row: Row) {
  return documentCapabilities(actor.subject, actor.target, actor.mode, {
    type: row.type,
    addedByParticipant: row.addedBy === "participant",
    reviewState: row.reviewState,
    quarantinedBy: row.quarantinedBy,
  });
}

/** A row as the actor sees it, with what they may do with it now. */
function view(actor: DocumentActor, row: Row): DocumentView {
  return {
    id: row.id,
    type: row.type,
    mediaType: row.mediaType,
    sizeBytes: row.sizeBytes,
    fileName: row.fileName,
    addedAt: row.addedAt,
    addedBy: row.addedBy === "participant" ? "participant" : "staff",
    onBehalf: row.onBehalf,
    review: { state: row.reviewState, reasonCode: row.reviewReason, reviewedAt: row.reviewedAt },
    quarantine:
      row.quarantineReason === null
        ? null
        : { reasonCode: row.quarantineReason, quarantinedAt: row.quarantinedAt! },
    capabilities: capabilitiesOf(actor, row),
  };
}

export function documentService(deps: Deps) {
  const { db, logger, clock } = deps;
  const files = deps.documentFiles;
  const registry = deps.formRegistry ?? formRegistry(deps.env.configDir);
  const slots = deps.uploadSlots ?? uploadSlots;
  const key = documentEncryptionKey(deps.env.documentEncryptionKey);

  /** The participation's live documents of the types, oldest first; one when `documentId`. */
  async function rows(
    participationId: string,
    types: readonly DocumentType[],
    documentId?: string,
  ): Promise<Row[]> {
    if (types.length === 0) return [];
    return db
      .select(selected)
      .from(document)
      .where(
        and(
          eq(document.participationId, participationId),
          isNull(document.deletedAt),
          inArray(document.type, [...types]),
          documentId === undefined ? undefined : eq(document.id, documentId),
        ),
      )
      .orderBy(asc(document.addedAt), asc(document.id));
  }

  /** One live document of the participation the actor may read, else undefined (a 404). */
  async function one(actor: DocumentActor, documentId: string) {
    const types = readableDocumentTypes(actor.subject, actor.target, actor.mode);
    const [row] = await rows(actor.target.participationId, types, documentId);
    return row;
  }

  async function list(actor: DocumentActor): Promise<DocumentList> {
    const types = readableDocumentTypes(actor.subject, actor.target, actor.mode);
    const found = await rows(actor.target.participationId, types);
    return {
      documents: found.map((row) => view(actor, row)),
      addableTypes: addableDocumentTypes(actor.subject, actor.target, actor.mode),
      limits: { ...documentLimits },
    };
  }

  /**
   * The upload path (data-protection.md, uploads as built; ADR-0010, documents): permission → the gate → decode → detect the type →
   * scan → encrypt → store → `add_document`. An infected or unscannable file is never stored; on a
   * refusal of the function the stored object is deleted at once. An object a crash leaves between
   * the store and the commit is the retention job's (Slice 7), which reconciles objects without a
   * row.
   */
  async function upload(c: Context<AppEnv>, actor: DocumentActor, input: DocumentUploadInput) {
    const { type } = input;
    const participationId = actor.target.participationId;
    const log = (outcome: string, size?: number) =>
      logger.info(
        {
          requestId: c.get("requestId"),
          participationId,
          documentType: type,
          ...(size !== undefined && { sizeBucket: sizeBucket(size) }),
          outcome,
        },
        "document upload",
      );
    if (!uploadableDocumentTypes.includes(type)) {
      return domainProblem(c, [{ code: "document_type_not_supported", field: "type" }]);
    }
    const permission = mayAddDocument(actor.subject, type, actor.target, actor.mode);
    if (!permission.ok) return denied(c, permission);
    const origin = scanUploadProblems(type, input);
    if (origin.length > 0) return domainProblem(c, origin);
    if (!files) return storageUnavailable(c);
    let fileName: string | null = null;
    if (documentTypeEntry(type).fileName) {
      fileName = documentFileName(input.fileName);
      if (fileName === null) {
        return problem(c, "validation-error", {
          errors: [{ pointer: "/fileName", code: "file_name_invalid", detail: "1–200 characters" }],
        });
      }
    }
    let release: () => void;
    try {
      release = await slots.acquire();
    } catch (error) {
      if (!(error instanceof ImportBusyError)) throw error;
      log("upload_busy");
      return busy(c, "upload_busy", 10);
    }
    try {
      const content = new Uint8Array(Buffer.from(input.content, "base64"));
      if (content.length === 0) return domainProblem(c, [{ code: "file_empty", field: "content" }]);
      if (content.length > documentLimits.maxBytes) {
        log("file_too_large");
        return domainProblem(c, [{ code: "file_too_large", field: "content" }]);
      }
      const mediaType = detectFileType(content);
      if (mediaType === null) {
        log("file_type_not_allowed", content.length);
        return domainProblem(c, [{ code: "file_type_not_allowed", field: "content" }]);
      }
      let verdict;
      try {
        verdict = await files.scanner.scan(content);
      } catch (error) {
        if (!(error instanceof ScannerUnavailable)) throw error;
        log("scan_unavailable", content.length);
        return busy(c, "scan_unavailable", 30);
      }
      if (verdict !== "clean") {
        const code = verdict === "infected" ? "file_infected" : "file_unscannable";
        try {
          await db.execute(sql`select record_document_upload_rejected(
            p_context => ${actor.context}, p_participation_id => ${participationId}::uuid,
            p_type => ${type}::document_type, p_code => ${code},
            p_token_hash => ${actor.tokenHash}::text) as result`);
        } catch (error) {
          return refused(c, error);
        }
        log(code, content.length);
        return domainProblem(c, [{ code, field: "content" }]);
      }
      const id = randomUUID();
      const sealed = encryptDocument(key, { documentId: id, participationId, type }, content);
      const sha256 = createHash("sha256").update(content).digest("hex");
      try {
        await files.storage.put(objectKey(id), sealed.object);
      } catch (error) {
        logger.error({ requestId: c.get("requestId"), error: errorForLog(error) }, "store failed");
        log("storage_unavailable", content.length);
        return storageUnavailable(c);
      }
      try {
        await db.execute(sql`select add_document(
          p_context => ${actor.context}, p_participation_id => ${participationId}::uuid,
          p_id => ${id}::uuid, p_type => ${type}::document_type,
          p_media_type => ${mediaType}::document_media_type,
          p_size_bytes => ${content.length}::integer, p_content_sha256 => ${sha256},
          p_file_name => ${fileName}::text, p_key_id => ${sealed.keyId},
          p_wrapped_key => ${Buffer.from(sealed.wrappedKey)}::bytea,
          p_token_hash => ${actor.tokenHash}::text,
          p_scan_origin => ${input.origin ?? null}::scan_origin,
          p_generation_document_id => ${input.generationDocumentId ?? null}::uuid) as result`);
      } catch (error) {
        await files.storage.delete(objectKey(id)).catch((cleanup: unknown) => {
          logger.error(
            { requestId: c.get("requestId"), error: errorForLog(cleanup) },
            "cleanup failed",
          );
        });
        log(functionRefusal(error) ?? "failed", content.length);
        return refused(c, error);
      }
      log("stored", content.length);
      const [row] = await rows(participationId, [type], id);
      c.header("Cache-Control", "no-store");
      return c.json(view(actor, row!), 201);
    } finally {
      release();
    }
  }

  /** The opening (Q147): logged, a link bound to the actor's session, valid 60 s. */
  async function open(c: Context<AppEnv>, actor: DocumentActor, documentId: string) {
    const row = await one(actor, documentId);
    if (!row) return problem(c, "not-found");
    if (row.quarantinedBy !== null) return domainProblem(c, ["document_quarantined"]);
    if (!view(actor, row).capabilities.open) return problem(c, "forbidden");
    if (!files) return storageUnavailable(c);
    const token = randomBytes(32).toString("base64url");
    const linkHash = createHash("sha256").update(token).digest("hex");
    let expiresAt: string;
    try {
      const { rows: opened } = await db.execute<{ result: string }>(sql`select to_char(
        open_document(p_context => ${actor.context}, p_document_id => ${documentId}::uuid,
          p_session_kind => ${actor.session.kind}::document_session_kind,
          p_session_hash => ${actor.session.hash}, p_link_hash => ${linkHash})
        at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as result`);
      expiresAt = opened[0]!.result;
    } catch (error) {
      return refused(c, error);
    }
    c.header("Cache-Control", "no-store");
    return c.json({ url: `/api/v1/document-content/${token}`, expiresAt }, 201);
  }

  /** A review: once and final, staff in normal mode. */
  async function review(
    c: Context<AppEnv>,
    actor: DocumentActor,
    documentId: string,
    input: DocumentReviewInput,
  ) {
    const row = await one(actor, documentId);
    if (!row) return problem(c, "not-found");
    const permission = mayReviewDocument(actor.subject, row.type, actor.target, actor.mode);
    if (!permission.ok) return denied(c, permission);
    if (row.reviewState !== "unreviewed") return domainProblem(c, ["document_reviewed"]);
    if (row.quarantinedBy !== null) return domainProblem(c, ["document_quarantined"]);
    const { scan, kug200bScan } = input;
    // A signed scan's acceptance takes its form's record (data-protection.md, signed scans): the
    // TL 407's `scan`, the Kug 200b's `kug200bScan`; nothing else does.
    const accepted = input.decision === "accepted";
    const tl407 = row.type === "tl407_signed_scan" && accepted;
    const kug200b = row.type === "kug200b_signed_scan" && accepted;
    if (tl407 !== (scan !== undefined)) {
      const code = tl407 ? "scan_required" : "scan_not_allowed";
      return domainProblem(c, [{ code, field: "scan" }]);
    }
    if (kug200b !== (kug200bScan !== undefined)) {
      const code = kug200b ? "scan_required" : "scan_not_allowed";
      return domainProblem(c, [{ code, field: "kug200bScan" }]);
    }
    if (scan || kug200bScan) {
      const generatedOn = await generationDateOf(row.generationDocumentId);
      const form = scanForms[row.type]!;
      const versionKnown = (version: string) => registry.versions(form).includes(version);
      const origin = { origin: row.scanOrigin!, generatedOn };
      const [issues, base] = scan
        ? [scanReviewProblems(scan, origin, clock.today(), versionKnown), "scan"]
        : [
            kug200bScanReviewProblems(kug200bScan!, origin, clock.today(), versionKnown),
            "kug200bScan",
          ];
      if (issues.length > 0) {
        return domainProblem(
          c,
          issues.map(({ code, field }) => ({ code, field: `${base}/${field}` })),
        );
      }
    }
    try {
      await db.execute(sql`select review_document(
        p_context => ${actor.context}, p_document_id => ${documentId}::uuid,
        p_decision => ${input.decision}::document_review_state,
        p_reason => ${input.reasonCode ?? null}::document_review_reason,
        p_signed_on => ${scan?.participantSignedOn ?? kug200bScan?.signedOn ?? null}::date,
        p_countersigned_on => ${scan?.profilerSignedOn ?? null}::date,
        p_confirmations => ${scan || kug200bScan ? `{${(scan ?? kug200bScan)!.confirmations.join(",")}}` : null}::text[],
        p_form_version => ${scan?.formVersion ?? kug200bScan?.formVersion ?? null}::text,
        p_declarations => ${scan ? JSON.stringify(scan.declarations) : null}::jsonb) as result`);
    } catch (error) {
      return refused(c, error);
    }
    const [after] = await rows(actor.target.participationId, [row.type], documentId);
    return c.json(view(actor, after!), 200);
  }

  /**
   * A deletion: the row becomes a tombstone and the object's purge is queued in the same
   * transaction; without pg-boss the purge runs after the response.
   */
  async function remove(
    c: Context<AppEnv>,
    actor: DocumentActor,
    documentId: string,
    reason: DocumentDeleteReason | null,
  ) {
    const row = await one(actor, documentId);
    if (!row) return problem(c, "not-found");
    const permission = mayDeleteDocument(actor.subject, row.type, actor.target, actor.mode, {
      addedByParticipant: row.addedBy === "participant",
      reviewState: row.reviewState,
    });
    if (!permission.ok) return denied(c, permission);
    if (reason !== null && !documentDeleteReasons(row.type).includes(reason)) {
      return domainProblem(c, [{ code: "delete_reason_not_allowed", field: "reasonCode" }]);
    }
    try {
      await transactionWithClient(db, async (tx, client) => {
        await tx.execute(sql`select delete_document(
          p_context => ${actor.context}, p_document_id => ${documentId}::uuid,
          p_reason => ${reason}::document_delete_reason,
          p_token_hash => ${actor.tokenHash}::text) as result`);
        await deps.documentPurges?.enqueue(documentId, {
          executeSql: (text, values) => client.query(text, values),
        });
      });
    } catch (error) {
      return refused(c, error);
    }
    if (!deps.documentPurges && files) {
      const storage = files.storage;
      deps.detached!.run("documents.purge-object", async () => {
        await purgeDocumentObject({ db, storage, logger }, documentId, `detached:${documentId}`);
      });
    }
    return c.body(null, 204);
  }

  /**
   * Quarantine at once, or its lift (data-protection.md, quarantine; Q183): staff in normal mode as
   * the permissions say; the functions check again under the lock.
   */
  async function quarantine(
    c: Context<AppEnv>,
    actor: DocumentActor,
    documentId: string,
    reason: QuarantineReason | null,
  ) {
    const row = await one(actor, documentId);
    if (!row) return problem(c, "not-found");
    const { subject, target, mode } = actor;
    const permission =
      reason !== null || row.quarantinedBy === null
        ? mayQuarantineDocument(subject, row.type, target, mode)
        : mayLiftDocumentQuarantine(subject, row.type, target, mode, row.quarantinedBy);
    if (!permission.ok) return denied(c, permission);
    if ((reason !== null) !== (row.quarantinedBy === null)) {
      return domainProblem(c, [
        reason !== null ? "document_quarantined" : "document_not_quarantined",
      ]);
    }
    try {
      await db.execute(
        reason === null
          ? sql`select lift_document_quarantine(p_context => ${actor.context},
              p_document_id => ${documentId}::uuid) as result`
          : sql`select quarantine_document(p_context => ${actor.context},
              p_document_id => ${documentId}::uuid,
              p_reason => ${reason}::document_quarantine_reason) as result`,
      );
    } catch (error) {
      return refused(c, error);
    }
    const [after] = await rows(actor.target.participationId, [row.type], documentId);
    return c.json(view(actor, after!), 200);
  }

  /** The Berlin date a generated form was generated on, or null. */
  async function generationDateOf(generationDocumentId: string | null) {
    if (generationDocumentId === null) return null;
    const { rows: found } = await db.execute<{ day: string }>(sql`select
      (generated_at at time zone 'Europe/Berlin')::date::text as day
      from form_generation where document_id = ${generationDocumentId}::uuid`);
    return found[0]?.day ?? null;
  }

  return { rows, list, upload, open, review, remove, quarantine };
}

export type DocumentService = ReturnType<typeof documentService>;
