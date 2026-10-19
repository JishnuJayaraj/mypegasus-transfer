import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { ImportFileError } from "./errors";
import type { ParsedSheet, ParseRequest } from "./parse-core";
import { parseSlots } from "./slots";
import { checkZipDirectory, hasZipSignature } from "./zip-check";

export type { ParsedSheet, ParseRequest } from "./parse-core";

// The one module that turns an uploaded file into cells (Slice 2 plan 5.11, D6, spike S1). A
// workbook is never parsed in the API process: after the ZIP central-directory check, the bytes go
// to a worker thread with resource limits and a timeout, which expands each entry only up to its
// declared size and then reads the sheet. A worker that runs out of memory or time is stopped and
// the API keeps serving; the request is refused as `file_too_complex`. CSV goes through the same
// worker, so there is one path to reason about. Replacing a parser touches `parse-core.ts` only.

const timeoutMs = 15_000;
const resourceLimits = {
  maxOldGenerationSizeMb: 256,
  maxYoungGenerationSizeMb: 32,
  stackSizeMb: 4,
};

/**
 * What to start: the Vite build emits `parse-worker.js` next to the bundle's other chunks; in
 * development and tests (`.ts` sources) the worker is the TypeScript file, started through a small
 * bootstrap that registers tsx's loader first (`--import` in `execArgv` doesn't reach a worker's
 * module resolution).
 */
function workerEntry(): { entry: string | URL; eval: boolean } {
  if (!import.meta.url.endsWith(".ts")) {
    return { entry: new URL("./parse-worker.js", import.meta.url), eval: false };
  }
  const tsx = createRequire(import.meta.url).resolve("tsx/esm");
  const api = pathToFileURL(join(dirname(tsx), "api/index.mjs")).href;
  const worker = new URL("./parse-worker.ts", import.meta.url).href;
  return {
    entry: `const { register } = await import(${JSON.stringify(api)}); register(); await import(${JSON.stringify(worker)});`,
    eval: true,
  };
}

/**
 * Parses an uploaded `.xlsx` or CSV file into cells. Throws `ImportFileError` with a stable code
 * for a file that can't be read, and `ImportBusyError` when no worker slot became free in time
 * (R43); any other error is a bug.
 */
export async function parseSpreadsheet(request: ParseRequest): Promise<ParsedSheet> {
  // Always, before anything is expanded (D6).
  if (hasZipSignature(request.bytes)) checkZipDirectory(request.bytes);
  const release = await parseSlots.acquire();
  try {
    return await runWorker(request);
  } finally {
    release();
  }
}

/** One worker with its limits and timeout; settled exactly once, then terminated. */
function runWorker(request: ParseRequest): Promise<ParsedSheet> {
  const { entry, eval: evaluate } = workerEntry();
  return new Promise<ParsedSheet>((resolve, reject) => {
    const worker = new Worker(entry, { eval: evaluate, workerData: request, resourceLimits });
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      settle();
    };
    const timer = setTimeout(
      () => finish(() => reject(new ImportFileError("file_too_complex"))),
      timeoutMs,
    );
    worker.once("message", (message: { ok: boolean; result?: ParsedSheet; code?: string }) =>
      finish(() =>
        message.ok
          ? resolve(message.result as ParsedSheet)
          : reject(new ImportFileError(message.code as ImportFileError["code"])),
      ),
    );
    // Out of memory, an uncaught error or an exit without an answer: never a message from the file.
    worker.once("error", () => finish(() => reject(new ImportFileError("file_too_complex"))));
    worker.once("exit", () => finish(() => reject(new ImportFileError("file_too_complex"))));
  });
}
