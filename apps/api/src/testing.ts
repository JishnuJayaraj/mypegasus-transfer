import { SystemClock, type Clock } from "@transfer/adapters";
import { createDb, transactionWithClient, type Database } from "@transfer/db";
import { testDatabaseUrls } from "@transfer/db/testing";
import { ProblemDetails } from "@transfer/domain";
import { pino } from "pino";
import { expect } from "vitest";
import type { z } from "zod";
import { createApp } from "./app";
import type { Deps } from "./context";
import type { Env } from "./env";
import { createDetached } from "./detached";

export const testEnv: Env = {
  nodeEnv: "test",
  authMode: "dev",
  sessionSecret: "test-secret-test-secret-test-secret",
  appOrigins: ["http://localhost:5173"],
  databaseUrl: "unused",
  port: 0,
  logLevel: "info",
  // Tests start pg-boss themselves (ADR-0011).
  jobsEnabled: false,
  jobsLifecycleTime: "04:15",
  clock: "system",
  configDir: undefined,
  accessCodeSecret: "test-access-code-secret-test-access-code-secret",
  fieldEncryptionKey: "test-field-encryption-key-test-field-encryption-key",
  portalPublicUrl: "https://portal.test/portal/",
  mailAdapter: "mock",
  smsAdapter: "mock",
  documentEncryptionKey: "test-document-encryption-key-test-document-encryption-key",
  storageAdapter: "memory",
  storageDir: "unused",
  virusScanAdapter: "mock",
  pdfAdapter: "mock",
};

export const origin = testEnv.appOrigins[0]!;

/** An app on `transfer_test` whose log lines are captured as strings. */
export function testApp(
  options: {
    env?: Partial<Env>;
    db?: Database;
    spa?: Deps["spa"];
    clock?: Clock;
    importSlots?: Deps["importSlots"];
    oidc?: Deps["oidc"];
    mailer?: Deps["mailer"];
    smsSender?: Deps["smsSender"];
    outbox?: Deps["outbox"];
    activationNotices?: Deps["activationNotices"];
    fileStorage?: Deps["fileStorage"];
    virusScanner?: Deps["virusScanner"];
    uploadSlots?: Deps["uploadSlots"];
    documentPurges?: Deps["documentPurges"];
    reminders?: Deps["reminders"];
    pdfRenderer?: Deps["pdfRenderer"];
  } = {},
) {
  const logs: string[] = [];
  const logger = pino({ level: "info" }, { write: (line: string) => logs.push(line) });
  const db = options.db ?? createDb(testDatabaseUrls().app);
  const detached = createDetached(logger);
  const app = createApp({
    db,
    env: { ...testEnv, ...options.env },
    logger,
    clock: options.clock ?? new SystemClock(),
    spa: options.spa,
    importSlots: options.importSlots,
    oidc: options.oidc,
    mailer: options.mailer,
    smsSender: options.smsSender,
    outbox: options.outbox,
    activationNotices: options.activationNotices,
    fileStorage: options.fileStorage,
    virusScanner: options.virusScanner,
    uploadSlots: options.uploadSlots,
    documentPurges: options.documentPurges,
    reminders: options.reminders,
    pdfRenderer: options.pdfRenderer,
    detached,
  });
  return { app, db, logs, detached };
}

export function jsonRequest(method: string, body: unknown, headers: Record<string, string> = {}) {
  return {
    method,
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", Origin: origin, ...headers },
  };
}

/** Logs in through the dev session route and returns the Cookie header to send. */
export async function login(app: ReturnType<typeof createApp>, staffUserId: string) {
  const res = await app.request("/api/v1/dev/session", jsonRequest("POST", { staffUserId }));
  if (res.status !== 204)
    throw new Error(`dev login failed with ${res.status}: ${await res.text()}`);
  return { Cookie: res.headers.get("set-cookie")!.split(";")[0]! };
}

/** Parses a response body with its schema, so tests also check the response shape. */
export async function readJson<T extends z.ZodType>(
  res: Response,
  schema: T,
): Promise<z.output<T>> {
  return schema.parse(await res.json());
}

export async function expectProblem(res: Response, status: number, type: string) {
  expect(res.status).toBe(status);
  expect(res.headers.get("content-type")).toMatch(/^application\/problem\+json/);
  const body = await readJson(res, ProblemDetails);
  expect(body).toMatchObject({ type: `urn:transfer:problem:${type}`, status });
  return body;
}

/** A pooled connection, as `transactionWithClient` hands it out. */
type PoolClient = Parameters<Parameters<typeof transactionWithClient>[1]>[1];

/**
 * Counts the SQL statements `db` sends while `work` runs: every query on every pooled connection
 * checked out meanwhile, a transaction's `begin` and `commit` included. It proves a request's
 * shape (no statement per row), never its speed.
 */
export async function countStatements<T>(db: Database, work: () => T | Promise<T>) {
  const pool = db.$client;
  let statements = 0;
  const originals = new Map<PoolClient, PoolClient["query"]>();
  const watch = (client: PoolClient) => {
    if (originals.has(client)) return;
    const query = client.query;
    originals.set(client, query);
    client.query = ((...args: unknown[]) => {
      statements++;
      return Reflect.apply(query, client, args);
    }) as PoolClient["query"];
  };
  pool.on("acquire", watch);
  try {
    const result = await work();
    return { result, statements };
  } finally {
    pool.off("acquire", watch);
    for (const [client, query] of originals) client.query = query;
  }
}

/**
 * A timing budget (CLAUDE.md, how we work): above `ceiling` it always fails, since that is a bug and
 * not a slow runner; above `budget` it fails only with `PERF_BUDGET=strict` (.env.example) and
 * otherwise warns with the likely causes. Invariants are asserted before it, never through it.
 */
export function expectWithinBudget(
  label: string,
  ms: number,
  { budget, ceiling, causes }: { budget: number; ceiling: number; causes: string },
) {
  expect(ms, `${label}: ${Math.round(ms)} ms, hard ceiling ${ceiling} ms`).toBeLessThan(ceiling);
  if (ms < budget) return;
  const message = `${label}: ${Math.round(ms)} ms, over the budget of ${budget} ms. Likely causes: ${causes}`;
  if (process.env.PERF_BUDGET === "strict") expect.fail(message);
  // oxlint-disable-next-line no-console -- a soft budget warns instead of failing (PERF_BUDGET)
  console.warn(`WARNING ${message}`);
}
