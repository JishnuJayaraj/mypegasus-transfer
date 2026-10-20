// Fails if any tsconfig*.json sets `ignoreDeprecations` (ADR-0003).
// Deprecated compiler options must be removed, not silenced, so that the move to TS 7 stays small.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const skip = new Set(["node_modules", ".git", "dist", ".tsbuild", "coverage"]);

function* tsconfigFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!skip.has(entry.name)) yield* tsconfigFiles(join(dir, entry.name));
    } else if (/^tsconfig.*\.json$/.test(entry.name)) {
      yield join(dir, entry.name);
    }
  }
}

const offenders = [...tsconfigFiles(root)].filter((file) =>
  readFileSync(file, "utf8").includes("ignoreDeprecations"),
);

if (offenders.length > 0) {
  console.error("`ignoreDeprecations` is not allowed. Remove the deprecated option instead:");
  for (const file of offenders) console.error(`  ${relative(root, file)}`);
  process.exit(1);
}
