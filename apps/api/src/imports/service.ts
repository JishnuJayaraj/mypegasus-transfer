import type { Clock } from "@transfer/adapters";
import type { Database } from "@transfer/db";
import type { ImportPreviewInput } from "@transfer/domain";
import type { Logger } from "pino";
import type { Release } from "../projects/template-pins";
import type { ImportActor, ImportContext } from "./analysis";
import { mappingKey, tokenKey } from "./keys";
import { previewImport } from "./preview";

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
};

export function createImportService(deps: Deps) {
  const { sessionSecret, ...rest } = deps;
  const ctx: ImportContext = {
    ...rest,
    mapKey: mappingKey(sessionSecret),
    tokKey: tokenKey(sessionSecret),
  };
  return {
    preview: (actor: ImportActor, projectId: string, input: ImportPreviewInput) =>
      previewImport(ctx, actor, projectId, input),
  };
}

export type ImportService = ReturnType<typeof createImportService>;
