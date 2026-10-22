/**
 * Object storage for document files (ADR-0006). The API stores only encrypted objects, under
 * keys without a name, project or person (`documents/<documentId>`, data-protection.md,
 * uploads). A real S3-compatible adapter comes with its contract test and AVV before the pilot
 * (Q149); until then production has no storage.
 */
export interface FileStorage {
  /** Stores the object, replacing one under the same key. */
  put(key: string, content: Uint8Array): Promise<void>;
  /** Throws `FileNotFound` when no object has the key. */
  get(key: string): Promise<Uint8Array>;
  /** Removes the object; a missing key succeeds (the purge job retries). */
  delete(key: string): Promise<void>;
}

export class FileNotFound extends Error {
  constructor() {
    super("File not found");
    this.name = "FileNotFound";
  }
}

// Lower-case segments of letters, digits and hyphens: no `..`, no absolute path, no name.
const keyPattern = /^[a-z0-9-]+(\/[a-z0-9-]+)*$/;

/** Refuses a key no adapter accepts; the error never repeats the key. */
export function assertStorageKey(key: string): void {
  if (!keyPattern.test(key)) throw new RangeError("Invalid storage key");
}
