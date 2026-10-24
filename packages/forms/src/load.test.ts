import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { formVersionInUse } from "@transfer/domain";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildFormsManifest,
  fontsDir,
  FormRegistryError,
  formsDir,
  loadFont,
  loadFormsManifest,
  loadFormVersion,
  loadOwnTemplate,
  renderFormsManifest,
} from "./load";

const copies: string[] = [];
afterEach(() => {
  for (const dir of copies.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A copy of a directory to break, as a directory URL. */
function copy(dir: URL): URL {
  const target = mkdtempSync(join(tmpdir(), "forms-"));
  copies.push(target);
  cpSync(dir, target, { recursive: true });
  return pathToFileURL(`${target}/`);
}

const edit = (file: URL, change: (json: Record<string, unknown>) => object) =>
  writeFileSync(file, JSON.stringify(change(JSON.parse(readFileSync(file, "utf8")))));

const refused = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return error instanceof FormRegistryError ? `${error.path}: ${error.code}` : String(error);
  }
  return "no error";
};

describe("the forms manifest (ADR-0009)", () => {
  it("is committed as `pnpm generate` writes it", () => {
    expect(readFileSync(new URL("manifest.json", formsDir), "utf8")).toBe(renderFormsManifest());
    expect(loadFormsManifest()).toEqual(buildFormsManifest());
  });

  it("has one version of each form in use today (no effective dates reviewed yet)", () => {
    const { forms } = loadFormsManifest();
    for (const formCode of ["tl407", "kug200b", "kug200a"] as const) {
      expect(formVersionInUse(forms, formCode, "2026-10-24")?.formCode).toBe(formCode);
    }
  });
});

describe("loadFormVersion", () => {
  it("refuses a file naming another form or version than its folder", () => {
    const dir = copy(formsDir);
    edit(new URL("ba/tl407/08-2025/manifest.json", dir), (json) => ({
      ...json,
      version: "09-2025",
    }));
    expect(refused(() => loadFormVersion("tl407", "08-2025", dir))).toBe(
      "ba/tl407/08-2025: path_mismatch",
    );
  });

  it("refuses a blank whose SHA-256 differs from the manifest's or the source's", () => {
    const dir = copy(formsDir);
    const sha256 = "0".repeat(64);
    edit(new URL("ba/kug200b/09-2021/manifest.json", dir), (json) => ({ ...json, sha256 }));
    expect(refused(() => loadFormVersion("kug200b", "09-2021", dir))).toBe(
      "ba/kug200b/09-2021: hash_mismatch",
    );
    edit(new URL("ba/kug200a/07-2025/source.json", dir), (json) => ({ ...json, sha256 }));
    expect(refused(() => loadFormVersion("kug200a", "07-2025", dir))).toBe(
      "ba/kug200a/07-2025: hash_mismatch",
    );
  });
});

describe("loadOwnTemplate", () => {
  it("loads the Anlage template's three files", () => {
    const template = loadOwnTemplate("anlage-profilingbogen:v1");
    expect(template.index).toContain("{{sections}}");
    expect(template.header).toContain("{{person}}");
    expect(template.footer).toContain('class="totalPages"');
  });

  it("refuses an unknown template and a changed file", () => {
    expect(refused(() => loadOwnTemplate("anlage-profilingbogen:v2"))).toBe(
      "anlage-profilingbogen:v2: unknown_template",
    );
    const dir = copy(formsDir);
    writeFileSync(new URL("own/anlage-profilingbogen/v1/footer.html", dir), "<p>changed</p>");
    expect(refused(() => loadOwnTemplate("anlage-profilingbogen:v1", dir))).toBe(
      "anlage-profilingbogen:v1: hash_mismatch",
    );
  });
});

describe("loadFont", () => {
  it("loads the subset and refuses a changed file", () => {
    expect(loadFont().byteLength).toBeGreaterThan(10_000);
    const dir = copy(fontsDir);
    writeFileSync(new URL("noto-sans-subset.ttf", dir), "not a font");
    expect(refused(() => loadFont(dir))).toBe("fonts: hash_mismatch");
  });
});
