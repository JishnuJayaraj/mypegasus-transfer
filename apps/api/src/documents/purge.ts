import type { FileStorage } from "@transfer/adapters";
import { sql, type Database } from "@transfer/db";
import type { Logger } from "pino";
import { jobNames } from "../jobs/names";
import { objectKey } from "./files";

/** Where the API queues a deleted document's purge inside the deletion's transaction (ADR-0011). */
export interface DocumentPurgeQueue {
  enqueue(
    documentId: string,
    db: { executeSql(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> },
  ): Promise<void>;
}

export type PurgeDeps = { db: Database; storage: FileStorage; logger: Logger };

/**
 * `documents.purge-object` (ADR-0011): deletes a deleted document's object and records
 * `purged_at`; reads nothing but the id. A live or unknown document is skipped (its object is
 * never purged), an object already gone succeeds, so a retry is harmless. Logs the job, its id,
 * the document id and the outcome.
 */
export async function purgeDocumentObject(
  { db, storage, logger }: PurgeDeps,
  documentId: string,
  jobId: string,
): Promise<"purged" | "skipped"> {
  const { rows } = await db.execute<{ deleted: boolean }>(
    sql`select deleted_at is not null as deleted from document where id = ${documentId}::uuid`,
  );
  const log = (outcome: string) =>
    logger.info({ job: jobNames.purgeDocument, jobId, documentId, outcome }, "document purge");
  if (!rows[0]?.deleted) {
    log("skipped");
    return "skipped";
  }
  await storage.delete(objectKey(documentId));
  await db.execute(sql`select record_document_purged(${documentId}::uuid) as result`);
  log("purged");
  return "purged";
}
