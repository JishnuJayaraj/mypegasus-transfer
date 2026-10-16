import { createDb } from "@transfer/db";
import { loadDotEnv, parseEnv } from "../env";
import { runLifecycleCli } from "../jobs/cli";
import { jobErrorCode } from "../jobs/errors";
import { createLogger, errorForLog } from "../logger";

// `pnpm jobs:lifecycle [--today YYYY-MM-DD]` (plan 5.9): the lifecycle sweep once, as the runtime
// role. Exits non-zero with a stable code on stderr (`run_not_due`, `invalid_arguments`, …),
// never an error message (CLAUDE.md rule 9).
loadDotEnv();
const env = parseEnv();
const logger = createLogger(env.logLevel);
const db = createDb(env.databaseUrl);
try {
  await runLifecycleCli({ argv: process.argv.slice(2), env, db, logger });
} catch (error) {
  const code = jobErrorCode(error);
  if (code === "unexpected") logger.error({ error: errorForLog(error) }, "jobs:lifecycle failed");
  process.stderr.write(`jobs:lifecycle: ${code}\n`);
  process.exitCode = 1;
} finally {
  await db.$client.end();
}
