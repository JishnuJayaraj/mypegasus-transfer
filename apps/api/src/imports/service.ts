import type { Clock } from "@transfer/adapters";
import type { Database } from "@transfer/db";
import type { ImportConfirmInput, ImportPreviewInput } from "@transfer/domain";
import type { Logger } from "pino";
import type { Release } from "../projects/template-pins";
import type { ImportActor, ImportContext } from "./analysis";
import { confirmImport } from "./confirm";
import { mappingKey, tokenKey } from "./keys";
import { previewImport } from "./preview";
import { parseSlots, type Slots } from "./slots";

export { ImportRefusal, type ImportActor } from "./analysis";

// The import's service (Slice 2 plan 5.11, D6, R17, R18): a stateless preview and an atomic
// confirm. The file is parsed before any transaction (in the worker); everything that decides
// what is written is read and checked in one transaction, the confirm's under the exclusive
// project lock. Nothing here logs a file name, a header or a value.

type Deps = {
  db: Database;
  release: Release;
  clock: Clock;
  logger: Logger;
  sessionSecret: string;
  /** The parse-worker slots (R43); the process's own unless a test brings its own. */
  slots?: Slots | undefined;
};

export function createImportService(deps: Deps) {
  const { sessionSecret, slots, ...rest } = deps;
  const ctx: ImportContext = {
    ...rest,
    slots: slots ?? parseSlots,
    mapKey: mappingKey(sessionSecret),
    tokKey: tokenKey(sessionSecret),
  };
  return {
    preview: (actor: ImportActor, projectId: string, input: ImportPreviewInput) =>
      previewImport(ctx, actor, projectId, input),
    confirm: (actor: ImportActor, projectId: string, input: ImportConfirmInput) =>
      confirmImport(ctx, actor, projectId, input),
  };
}

export type ImportService = ReturnType<typeof createImportService>;
