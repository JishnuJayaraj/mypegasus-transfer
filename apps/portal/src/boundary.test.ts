// @vitest-environment node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// AC-19, ADR-0001: the portal must not import staff code. The rule lives in .oxlintrc.json; this
// test lints fixture files that break it (they are ignored by `pnpm lint`).

const root = fileURLToPath(new URL("../../../", import.meta.url));

interface Diagnostic {
  code: string;
  filename: string;
}

function lint(fixture: string): Diagnostic[] {
  const result = spawnSync(
    `${root}node_modules/.bin/oxlint`,
    ["--no-ignore", "--format", "json", `apps/portal/lint-fixtures/${fixture}`],
    { cwd: root, encoding: "utf8" },
  );
  if (result.error) throw result.error;
  return (JSON.parse(result.stdout) as { diagnostics: Diagnostic[] }).diagnostics;
}

const restricted = (diagnostics: Diagnostic[]) =>
  diagnostics.filter((d) => d.code === "eslint(no-restricted-imports)");

describe("portal boundary rule", () => {
  it.each([
    ["the web app's package", "imports-web-package.ts"],
    ["a path inside the web app's package", "imports-web-subpath.ts"],
    ["a relative path into apps/web", "imports-web-path.ts"],
    ["a staff-only package (@transfer/staff-*)", "imports-staff-package.ts"],
  ])("fails the lint for an import of %s", (_, fixture) => {
    expect(restricted(lint(fixture))).toHaveLength(1);
  });

  it("allows the shared packages", () => {
    expect(lint("allowed.ts")).toEqual([]);
  });
});
