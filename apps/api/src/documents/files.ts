import {
  FilesystemFileStorage,
  MemoryFileStorage,
  MockVirusScanner,
  type FileStorage,
  type VirusScanner,
} from "@transfer/adapters";
import type { Env } from "../env";

/** Where document files go and what scans them before (ADR-0006). */
export type DocumentFiles = { storage: FileStorage; scanner: VirusScanner };

/**
 * The store and the scanner (ADR-0006; Q149 *assumed*): the filesystem (or, in tests, memory) and
 * the mock scanner outside production; none with `NODE_ENV=production`, so uploads and openings
 * answer `503 storage_unavailable` until an S3-compatible store and a ClamAV scanner exist with
 * their contract tests and AVV. A test or the server passes its own instances.
 */
export function documentFiles(
  env: Pick<Env, "nodeEnv" | "storageAdapter" | "storageDir">,
  given: Partial<DocumentFiles> = {},
): DocumentFiles | undefined {
  if (env.nodeEnv === "production") return undefined;
  return {
    storage:
      given.storage ??
      (env.storageAdapter === "memory"
        ? new MemoryFileStorage()
        : new FilesystemFileStorage(env.storageDir)),
    scanner: given.scanner ?? new MockVirusScanner(),
  };
}

/** A document's object key: no name, project or person in it (data-protection.md, uploads). */
export const objectKey = (documentId: string) => `documents/${documentId}`;
