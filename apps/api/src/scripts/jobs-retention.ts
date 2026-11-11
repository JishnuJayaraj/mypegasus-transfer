import { createDb } from "@transfer/db";
import { documentFiles } from "../documents/files";
import { loadDotEnv, parseRetentionEnv } from "../env";
import { runRetentionCli } from "../jobs/cli";
import { jobErrorCode } from "../jobs/errors";
import { createLogger, errorForLog } from "../logger";

// `pnpm jobs:retention [--dry-run] [--today YYYY-MM-DD]` (ADR-0011): one retention run as the
// retention role (`RETENTION_DATABASE_URL`; its own process, never the API's). Prints the summary
// (counts per class and outcome, never a subject); exits non-zero with a stable code on stderr.
loadDotEnv();
const env = parseRetentionEnv();
const logger = createLogger(env.logLevel);
const db = createDb(env.retentionDatabaseUrl);
try {
  const summary = await runRetentionCli({
    argv: process.argv.slice(2),
    env,
    db,
    storage: documentFiles(env)?.storage,
    logger,
  });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} catch (error) {
  const code = jobErrorCode(error);
  if (code === "unexpected") logger.error({ error: errorForLog(error) }, "jobs:retention failed");
  process.stderr.write(`jobs:retention: ${code}\n`);
  process.exitCode = 1;
} finally {
  await db.$client.end();
}
