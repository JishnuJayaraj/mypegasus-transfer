import { parentPort, workerData } from "node:worker_threads";
import { ImportFileError } from "./errors";
import { parseBytes, type ParseRequest } from "./parse-core";

// The parse worker's entry (Slice 2 plan 5.11, spike S1): one request in `workerData`, one message
// out. It answers with the grid or a stable refusal code; a message from the file never leaves it.
// The API process starts it with resource limits and a timeout (`parse.ts`).

/** A worker's parent port has no origin to name. */
const answer = (message: unknown) =>
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  parentPort!.postMessage(message);

parseBytes(workerData as ParseRequest).then(
  (result) => answer({ ok: true, result }),
  (error: unknown) =>
    answer({
      ok: false,
      code: error instanceof ImportFileError ? error.code : "unsupported_file",
    }),
);
