import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { templateFieldValidators } from "./field-schema";
import { loadBaseDefaults, loadTemplate, templatesDir } from "./load";
import { resolveForParticipation } from "./resolve";
import { ConfigError } from "./validate";

const nord = "beispielstadt-nord";
const sued = "beispielstadt-sued";
const samples = readdirSync(templatesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .flatMap((dir) =>
    readdirSync(new URL(`${dir.name}/`, templatesDir)).map((file) => ({
      agenturKey: dir.name,
      version: Number(file.replace(/\.json$/, "")),
      file: new URL(`${dir.name}/${file}`, templatesDir),
    })),
  )
  .toSorted((a, b) => a.file.href.localeCompare(b.file.href));

function failure(load: () => unknown) {
  try {
    load();
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    return error.issues.map(({ code, path, key }) => ({ code, path: path.join("/"), key }));
  }
  throw new Error("loaded");
}

describe("the sample templates (D8, AC-31)", () => {
  it("are the two fictional Agenturen, nord in two versions", () => {
    expect(samples.map(({ agenturKey, version }) => `${agenturKey}@${version}`)).toEqual([
      `${nord}@1`,
      `${nord}@2`,
      `${sued}@1`,
    ]);
  });

  const schema = z.fromJSONSchema(
    JSON.parse(
      readFileSync(new URL("../schema/regional-template.schema.json", import.meta.url), "utf8"),
    ),
  );

  it.each(samples)("$agenturKey@$version validates and loads from its pinned path", (sample) => {
    expect(schema.safeParse(JSON.parse(readFileSync(sample.file, "utf8"))).success).toBe(true);
    const template = loadTemplate(sample.agenturKey, sample.version);
    expect(template).toMatchObject({
      id: sample.agenturKey,
      version: sample.version,
      sample: true,
    });
    expect(template.label.de).toMatch(/Beispielstadt .*\(Beispiel\)$/);
  });

  it("supply every Agentur submission setting", () => {
    const base = loadBaseDefaults();
    for (const sample of samples) {
      const template = loadTemplate(sample.agenturKey, sample.version);
      const resolution = resolveForParticipation({
        base,
        templatesByAgentur: { [sample.agenturKey]: template },
        projectType: "ta_tg",
        projectAgenturKey: sample.agenturKey,
        placementAgenturKey: sample.agenturKey,
      });
      expect(resolution.blockers).toEqual([]);
    }
  });
});

describe("pinned versions (Q36, AC-35)", () => {
  const base = loadBaseDefaults();
  const resolve = (version: number) =>
    resolveForParticipation({
      base,
      templatesByAgentur: { [nord]: loadTemplate(nord, version), [sued]: loadTemplate(sued, 1) },
      projectType: "ta_tg",
      projectAgenturKey: sued,
      placementAgenturKey: nord,
    });

  it("a version 2 file doesn't change resolution for a project pinned to version 1", () => {
    const pinned = resolve(1);
    expect(pinned.config.settings.agentur_submission?.leadTimeDays).toBe(10);
    expect(pinned.config.rules.data_collection?.map((rule) => rule.id)).not.toContain(
      "beispielstadt-nord-mobile",
    );
    expect(pinned.provenance["settings.agentur_submission.leadTimeDays"]).toEqual({
      layer: `template:${nord}@1`,
    });
    // reading version 2 changes nothing for version 1
    const migrated = resolve(2);
    expect(resolve(1)).toEqual(pinned);
    expect(migrated.config.settings.agentur_submission?.leadTimeDays).toBe(14);
    expect(migrated.config.rules.data_collection?.map((rule) => rule.id)).toContain(
      "beispielstadt-nord-mobile",
    );
    expect(migrated.provenance["settings.agentur_submission.leadTimeDays"]).toEqual({
      layer: `template:${nord}@2`,
    });
  });
});

describe("loadTemplate", () => {
  const dir = mkdtempSync(join(tmpdir(), "templates-"));
  const root = pathToFileURL(`${dir}/`);
  const original = JSON.parse(readFileSync(new URL(`${nord}/1.json`, templatesDir), "utf8"));
  const write = (key: string, version: number, content: unknown) => {
    mkdirSync(join(dir, key), { recursive: true });
    writeFileSync(join(dir, key, `${version}.json`), JSON.stringify(content));
  };

  it("checks the reference before reading a file", () => {
    for (const [key, version] of [
      ["../beispielstadt-nord", 1],
      ["Beispielstadt", 1],
      [nord, 0],
      [nord, 1.5],
    ] as const) {
      expect(failure(() => loadTemplate(key, version, root))).toEqual([
        { code: "invalid_reference", path: "", key: undefined },
      ]);
    }
  });

  it("checks that the file is the template its path names", () => {
    write(nord, 3, original);
    expect(failure(() => loadTemplate(nord, 3, root))).toEqual([
      { code: "path_mismatch", path: "version", key: undefined },
    ]);
    write("beispielstadt-west", 1, original);
    expect(failure(() => loadTemplate("beispielstadt-west", 1, root))).toEqual([
      { code: "path_mismatch", path: "agenturKey", key: undefined },
    ]);
    write("beispielstadt-base", 1, loadBaseDefaults());
    expect(failure(() => loadTemplate("beispielstadt-base", 1, root))).toEqual([
      { code: "wrong_layer_kind", path: "kind", key: undefined },
    ]);
  });

  it("validates the layer", () => {
    write(nord, 4, { ...original, version: 4, settings: { colour: {} } });
    expect(failure(() => loadTemplate(nord, 4, root))).toEqual([
      { code: "unknown_key", path: "settings", key: "colour" },
    ]);
  });
});

describe("loadBaseDefaults", () => {
  it("reads packages/domain/config/base-defaults.json", () => {
    const base = loadBaseDefaults();
    expect(base.kind).toBe("base_defaults");
    expect(base).toEqual(
      JSON.parse(
        readFileSync(new URL("../../domain/config/base-defaults.json", import.meta.url), "utf8"),
      ),
    );
  });
});

describe("compiled field validators", () => {
  it("are cached per (template id, version)", () => {
    const v1 = templateFieldValidators(loadTemplate(nord, 1));
    expect(templateFieldValidators(loadTemplate(nord, 1))).toBe(v1);
    expect(templateFieldValidators(loadTemplate(nord, 2))).not.toBe(v1);
    const field = v1.get("custom.beispiel_zusatznachweis_nr");
    expect(field?.safeParse("BSP-42").success).toBe(true);
    expect(field?.safeParse("x".repeat(41)).success).toBe(false);
    expect(templateFieldValidators(loadTemplate(sued, 1)).size).toBe(0);
  });
});
