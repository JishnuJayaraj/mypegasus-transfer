import type { ImportFileErrorCode } from "@transfer/domain";

/** A file that can't be read, by a stable code and never a message from the file (5.11, AC-30). */
export class ImportFileError extends Error {
  override readonly name = "ImportFileError";

  constructor(readonly code: ImportFileErrorCode) {
    super(code);
  }
}
