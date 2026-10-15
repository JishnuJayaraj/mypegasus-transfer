import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { loadEnv, refuseInProduction } from "../env";

// Creates the roles and the transfer, transfer_test and transfer_e2e databases (idempotent).
// Uses DATABASE_ADMIN_URL (e.g. CI's service superuser) if set, otherwise `su postgres`
// (the cloud session's pre-installed PostgreSQL with peer authentication).
refuseInProduction("db:setup");
loadEnv();
const sql = readFileSync(new URL("../../sql/setup.sql", import.meta.url));
const adminUrl = process.env.DATABASE_ADMIN_URL;
const psql = adminUrl
  ? spawnSync("psql", ["--quiet", "--no-psqlrc", adminUrl], {
      input: sql,
      stdio: ["pipe", "inherit", "inherit"],
    })
  : spawnSync("su", ["postgres", "-c", "psql --quiet --no-psqlrc"], {
      input: sql,
      stdio: ["pipe", "inherit", "inherit"],
    });
if (psql.status !== 0) throw new Error("db:setup failed (psql output above)");
