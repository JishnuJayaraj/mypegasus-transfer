import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";

// scripts/check-template-immutability.mjs (plan 5.8, AC-9), run in a scratch git repository with
// the repo's layout: the script, the hash module it imports and its canonical form, and a
// templates directory.
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const template = { kind: "regional_template", version: 1, label: { de: "A" }, sample: true };

let dir: string;
const git = (...args: string[]) =>
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.org",
      "-c",
      "commit.gpgsign=false",
    ].concat(args),
    { cwd: dir, encoding: "utf8" },
  );
const write = (path: string, content: string) => {
  const file = join(dir, "packages/config/templates", path);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, content);
};
function check(args: string[] = [], env: Record<string, string> = {}) {
  const { status, stdout, stderr } = spawnSync(
    process.execPath,
    ["scripts/check-template-immutability.mjs", ...args],
    { cwd: dir, encoding: "utf8", env: { ...process.env, CI: "", TEMPLATE_BASE_REF: "", ...env } },
  );
  return { status, output: stdout + stderr };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "immutability-"));
  for (const path of [
    "scripts/check-template-immutability.mjs",
    "packages/config/src/hash.ts",
    "packages/config/src/canonical.ts",
  ]) {
    cpSync(join(repoRoot, path), join(dir, path), { recursive: true });
  }
  write("a/1.json", JSON.stringify(template, null, 2));
  write("manifest.json", "{}");
  git("init", "--quiet", "--initial-branch=work");
  git("add", ".");
  git("commit", "--quiet", "-m", "base");
  git("tag", "base");
  return () => rmSync(dir, { recursive: true, force: true });
});

describe("check-template-immutability (AC-9)", () => {
  it("passes for unchanged, reformatted and new versions and for the manifest", () => {
    expect(check(["base"]).status).toBe(0);
    write(
      "a/1.json",
      '{"sample":true,"label":{"de":"A"},"version":1.0,"kind":"regional_template"}',
    );
    write("a/2.json", JSON.stringify({ ...template, version: 2 }));
    write("b/1.json", JSON.stringify(template));
    write("manifest.json", '{"templates":[]}');
    expect(check(["base"])).toEqual({ status: 0, output: "" });
  });

  it("fails for a changed version", () => {
    write("a/1.json", JSON.stringify({ ...template, sample: false }));
    const { status, output } = check(["base"]);
    expect(status).toBe(1);
    expect(output).toContain("packages/config/templates/a/1.json: changed");
  });

  it("fails for a version that is no longer JSON", () => {
    write("a/1.json", "{");
    expect(check(["base"]).output).toContain("a/1.json: changed (not valid JSON)");
  });

  it("fails for a deleted version, renames included", () => {
    git("mv", "packages/config/templates/a/1.json", "packages/config/templates/a/3.json");
    const { status, output } = check(["base"]);
    expect(status).toBe(1);
    expect(output).toContain("packages/config/templates/a/1.json: deleted");
  });

  it("takes the base ref from TEMPLATE_BASE_REF", () => {
    write("a/1.json", "[]");
    expect(check([], { TEMPLATE_BASE_REF: "base" }).status).toBe(1);
  });

  it("fails for a base ref that isn't a commit here", () => {
    const { status, output } = check(["no-such-ref"]);
    expect(status).toBe(1);
    expect(output).toContain("base ref no-such-ref is not a commit here");
  });

  it("uses origin/main locally when fetched", () => {
    write("a/1.json", "[]");
    git("update-ref", "refs/remotes/origin/main", "base");
    const { status, output } = check();
    expect(status).toBe(1);
    expect(output).toContain("(base origin/main)");
  });

  it("passes with a notice locally without a base ref, and fails under CI", () => {
    write("a/1.json", "[]");
    expect(check()).toEqual({
      status: 0,
      output: "template immutability: no base ref and no origin/main; not checked\n",
    });
    expect(check([], { CI: "true" }).status).toBe(1);
  });
});
