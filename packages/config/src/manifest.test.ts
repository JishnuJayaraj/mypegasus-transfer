import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { canonicalHash } from "./hash";
import {
  baseDefaultsDir,
  buildManifest,
  configDirs,
  loadBaseDefaults,
  loadManifest,
  loadOrganisation,
  loadTemplate,
  organisationFile,
  renderManifest,
  templatesDir,
} from "./load";
import { compareTemplateVersions, TemplateManifest } from "./manifest";
import { ConfigError } from "./validate";

const readJson = (url: URL): unknown => JSON.parse(readFileSync(url, "utf8"));
const committed = loadManifest();

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "config-"));
  return { dir, url: pathToFileURL(`${dir}/`) };
}

describe("the template manifest (plan 5.8, AC-9)", () => {
  it("is what `pnpm generate` writes from the template files, byte for byte", () => {
    expect(readFileSync(new URL("manifest.json", templatesDir), "utf8")).toBe(renderManifest());
    expect(committed).toEqual(buildManifest());
  });

  it("lists every sample version with its labels and the sample flag", () => {
    expect(
      committed.templates.map(({ agenturKey, version, sample }) => [agenturKey, version, sample]),
    ).toEqual([
      ["beispielstadt-nord", 1, true],
      ["beispielstadt-nord", 2, true],
      ["beispielstadt-nord", 3, true],
      ["beispielstadt-sued", 1, true],
    ]);
    for (const entry of committed.templates) {
      expect(entry.label).toEqual(loadTemplate(entry.agenturKey, entry.version).label);
    }
  });

  it("carries the canonical hash of each file, which is also the hash of the loaded template", () => {
    for (const { agenturKey, version, sha256 } of committed.templates) {
      const file = new URL(`${agenturKey}/${version}.json`, templatesDir);
      expect(sha256).toBe(canonicalHash(readJson(file)));
      // the content a pin stores (PR 2c-2) has the same identity
      expect(sha256).toBe(canonicalHash(loadTemplate(agenturKey, version)));
    }
  });
});

describe("compareTemplateVersions", () => {
  it("orders by key in code units, then by version numerically", () => {
    const refs = [
      { agenturKey: "b", version: 10 },
      { agenturKey: "b", version: 2 },
      { agenturKey: "a-b", version: 1 },
      { agenturKey: "a", version: 3 },
      { agenturKey: "ab", version: 1 },
    ];
    expect(refs.toSorted(compareTemplateVersions)).toEqual([
      { agenturKey: "a", version: 3 },
      { agenturKey: "a-b", version: 1 },
      { agenturKey: "ab", version: 1 },
      { agenturKey: "b", version: 2 },
      { agenturKey: "b", version: 10 },
    ]);
    expect(compareTemplateVersions(refs[0]!, refs[0]!)).toBe(0);
  });
});

function write(dir: string, key: string, file: string, content: unknown) {
  mkdirSync(join(dir, key), { recursive: true });
  writeFileSync(join(dir, key, file), JSON.stringify(content, null, 4));
}

describe("buildManifest", () => {
  const original = readJson(new URL("beispielstadt-sued/1.json", templatesDir)) as object;
  const template = (key: string, version: number, extra: object = {}) => ({
    ...original,
    id: key,
    agenturKey: key,
    version,
    ...extra,
  });

  it("orders by key, then version numerically; ignores files beside the key directories", () => {
    const { dir, url } = scratch();
    write(dir, "b", "10.json", template("b", 10, { sample: false }));
    write(dir, "b", "2.json", template("b", 2));
    write(dir, "a-1", "1.json", template("a-1", 1, { sample: undefined }));
    writeFileSync(join(dir, "manifest.json"), "{}");
    const { templates } = buildManifest(url);
    expect(
      templates.map(({ agenturKey, version, sample }) => [agenturKey, version, sample]),
    ).toEqual([
      ["a-1", 1, false],
      ["b", 2, true],
      ["b", 10, false],
    ]);
    expect(templates[2]!.sha256).toBe(canonicalHash(template("b", 10, { sample: false })));
    expect(TemplateManifest.parse({ templates })).toEqual({ templates });
  });

  it.each(["draft.json", "01.json", "1.json.bak", "0.json"])(
    "refuses %s in a key directory",
    (file) => {
      const { dir, url } = scratch();
      write(dir, "a", file, template("a", 1));
      expect(() => buildManifest(url)).toThrow(ConfigError);
    },
  );

  it("validates every template through loadTemplate", () => {
    const { dir, url } = scratch();
    write(dir, "a", "1.json", template("a", 2));
    expect(() => buildManifest(url)).toThrow(/path_mismatch|a@1/);
  });
});

describe("loadManifest", () => {
  it("refuses a manifest that doesn't match its schema", () => {
    const { dir, url } = scratch();
    const [entry] = committed.templates;
    for (const manifest of [
      { templates: [{ ...entry, sha256: "ABC" }] },
      { templates: [{ ...entry, extra: 1 }] },
      { templates: [], generatedAt: "x" },
    ]) {
      writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
      expect(() => loadManifest(url)).toThrow(ZodError);
    }
  });

  // Pagination keys on (agenturKey, version): a duplicate or a misplaced entry would be skipped
  // or repeated, so only strictly increasing entries load.
  it.each(
    (() => {
      const [a, b, c] = committed.templates;
      return [
        ["a duplicate (agenturKey, version)", [a, b, b, c]],
        ["a duplicate with another hash", [a, { ...a, sha256: "0".repeat(64) }]],
        ["an out-of-order version", [b, a, c]],
        ["an out-of-order key", [c, a]],
      ] as const;
    })(),
  )("refuses %s", (_, templates) => {
    const { dir, url } = scratch();
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ templates }));
    expect(() => loadManifest(url)).toThrow(/manifest_not_strictly_ordered/);
  });

  it("names every entry that isn't after its predecessor", () => {
    const [a, b, c] = committed.templates;
    const result = TemplateManifest.safeParse({ templates: [b, a, c, c] });
    expect(result.error?.issues).toHaveLength(2);
    expect(result.error?.issues).toMatchObject([
      { path: ["templates", 1], params: { code: "manifest_not_strictly_ordered" } },
      { path: ["templates", 3], params: { code: "manifest_not_strictly_ordered" } },
    ]);
  });
});

describe("CONFIG_DIR (S2)", () => {
  it("defaults to the repo paths", () => {
    expect(configDirs()).toEqual({
      templates: templatesDir,
      baseDefaults: baseDefaultsDir,
      organisation: organisationFile,
    });
    expect(configDirs(undefined).baseDefaults.href).toMatch(/\/packages\/domain\/config\/$/);
  });

  it("holds templates/, base-defaults.json and organisation.json, as the API build copies them", () => {
    const { dir } = scratch();
    cpSync(new URL(".", templatesDir), join(dir, "templates"), { recursive: true });
    cpSync(new URL("base-defaults.json", baseDefaultsDir), join(dir, "base-defaults.json"));
    cpSync(organisationFile, join(dir, "organisation.json"));
    const dirs = configDirs(dir);
    expect(dirs.templates.href).toBe(pathToFileURL(`${dir}/templates/`).href);
    expect(loadManifest(dirs.templates)).toEqual(committed);
    expect(loadTemplate("beispielstadt-nord", 2, dirs.templates)).toEqual(
      loadTemplate("beispielstadt-nord", 2),
    );
    expect(loadBaseDefaults(dirs.baseDefaults)).toEqual(loadBaseDefaults());
    expect(loadOrganisation(dirs.organisation)).toEqual(loadOrganisation());
  });

  it("resolves a relative CONFIG_DIR against the working directory", () => {
    expect(configDirs("dist/config").baseDefaults.href).toBe(
      pathToFileURL(`${resolve("dist/config")}/`).href,
    );
  });
});
