// The fast check while working (agent-workflow.md, verifying the final change; ADR-0003, testing):
//   pnpm verify:changed [<base-ref>]
// Runs `pnpm typecheck`, `pnpm lint` and Vitest without coverage on the tests related to the files
// changed against the base (default origin/main): committed since the merge base, staged,
// unstaged and untracked, as `vitest --changed` sees them. Imports don't reveal what depends on a
// migration (and the SECURITY DEFINER functions written in them), the setup SQL, the Drizzle
// schema, the db testing helpers or a Vitest config, so a change to one of those runs the db and
// api projects in full. It prints what it runs and why. `pnpm verify`, `pnpm build` and
// `pnpm test:e2e` stay the gate before a push.
import { execFileSync, spawnSync } from "node:child_process";

const root = new URL("..", import.meta.url);
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });

const base = process.argv[2] || "origin/main";
try {
  git("rev-parse", "--verify", "--quiet", `${base}^{commit}`);
} catch {
  console.error(`verify:changed: ${base} is not a commit here (git fetch origin main first)`);
  process.exit(1);
}

const list = (output) => output.split("\0").filter(Boolean);
const changed = [
  ...new Set([
    ...list(git("diff", "--name-only", "-z", `${base}...HEAD`)),
    ...list(git("diff", "--cached", "--name-only", "-z")),
    ...list(git("ls-files", "-z", "--other", "--modified", "--exclude-standard")),
  ]),
].toSorted();

/** Changes whose dependants imports don't reveal: they run the db and api projects in full. */
const fullDatabaseRules = [
  {
    pattern: /^packages\/db\/migrations\//,
    why: "a migration (SECURITY DEFINER functions, grants)",
  },
  { pattern: /^packages\/db\/sql\//, why: "the roles and databases of `pnpm db:setup`" },
  { pattern: /^packages\/db\/src\/schema\.ts$/, why: "the Drizzle schema" },
  { pattern: /^packages\/db\/src\/testing\//, why: "the db testing helpers" },
  { pattern: /(^|\/)vitest\.(config|workers)\.[cm]?[jt]s$/, why: "a Vitest config" },
];
const reasons = changed.flatMap((file) => {
  const rule = fullDatabaseRules.find(({ pattern }) => pattern.test(file));
  return rule ? [`${file}: ${rule.why}`] : [];
});

const mergeBase = git("merge-base", base, "HEAD").trim().slice(0, 12);
console.log(
  `verify:changed: ${changed.length} file(s) changed against ${base} (merge base ${mergeBase})`,
);
for (const file of changed) console.log(`  ${file}`);

const vitest = ["exec", "vitest", "run", "--passWithNoTests"];
const steps = [
  { why: "typecheck (tsc -b, incremental)", args: ["typecheck"] },
  { why: "lint", args: ["lint"] },
];
if (reasons.length > 0) {
  steps.push(
    {
      why: `the db and api projects in full, because imports don't reveal what depends on:\n${reasons.map((r) => `    ${r}`).join("\n")}`,
      args: [...vitest, "--project", "db", "--project", "api"],
    },
    {
      why: "the tests of the other projects related to the changed files",
      args: [...vitest, "--changed", base, "--project", "!db", "--project", "!api"],
    },
  );
} else if (changed.length > 0) {
  steps.push({
    why: "the tests related to the changed files (vitest --changed, no coverage)",
    args: [...vitest, "--changed", base],
  });
} else {
  console.log("verify:changed: nothing changed, so no tests run");
}

for (const { why, args } of steps) {
  console.log(`\nverify:changed: ${why}\n  $ pnpm ${args.join(" ")}`);
  const run = spawnSync("pnpm", args, { cwd: root, stdio: "inherit" });
  if (run.status !== 0) {
    console.error(`\nverify:changed: failed at \`pnpm ${args.join(" ")}\``);
    process.exit(run.status ?? 1);
  }
}
console.log("\nverify:changed: passed. Before a push: pnpm verify, pnpm build and pnpm test:e2e.");
