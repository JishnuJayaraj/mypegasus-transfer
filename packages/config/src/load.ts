import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalHash } from "./hash";
import { compareTemplateVersions, TemplateManifest } from "./manifest";
import { AgenturKey, type BaseDefaults, type RegionalTemplate } from "./model";
import { ConfigError, parseLayer, type ConfigIssue } from "./validate";

// Node only (reads files): exported as `@transfer/config/load`, never from the package root,
// which the SPAs may import.

/** The seed templates: `templates/<agenturKey>/<version>.json` (MVP, ADR-0004). */
export const templatesDir = new URL("../templates/", import.meta.url);
/** The repo's directory of `base-defaults.json` (ADR-0004). */
export const baseDefaultsDir = new URL("../../domain/config/", import.meta.url);

/**
 * Where the configuration files are (spike S2): `CONFIG_DIR` holds `templates/` and
 * `base-defaults.json`, as the API build copies them to `dist/config/`; a relative path is
 * resolved against the working directory. Unset, the repo paths.
 */
export function configDirs(configDir?: string): { templates: URL; baseDefaults: URL } {
  if (configDir === undefined) return { templates: templatesDir, baseDefaults: baseDefaultsDir };
  const root = pathToFileURL(`${resolve(configDir)}/`);
  return { templates: new URL("templates/", root), baseDefaults: root };
}

/**
 * Reads one pinned template version (Q36). The file must be the template its path names: its
 * `agenturKey` (= `id`) and `version` match the reference. A version's content never changes.
 */
export function loadTemplate(
  agenturKey: string,
  version: number,
  dir: URL = templatesDir,
): RegionalTemplate {
  const name = `${agenturKey}@${version}`;
  if (!AgenturKey.safeParse(agenturKey).success || !Number.isInteger(version) || version < 1) {
    throw new ConfigError(name, [{ code: "invalid_reference", path: [] }]);
  }
  const layer = read(new URL(`${agenturKey}/${version}.json`, dir), name);
  const issues: ConfigIssue[] = [];
  if (layer.kind !== "regional_template") {
    issues.push({ code: "wrong_layer_kind", path: ["kind"] });
  } else if (layer.agenturKey !== agenturKey) {
    issues.push({ code: "path_mismatch", path: ["agenturKey"] });
  } else if (layer.version !== version) {
    issues.push({ code: "path_mismatch", path: ["version"] });
  }
  if (issues.length) throw new ConfigError(name, issues);
  return layer as RegionalTemplate;
}

/** The nationwide base defaults, `packages/domain/config/base-defaults.json` (ADR-0004). */
export function loadBaseDefaults(dir: URL = baseDefaultsDir): BaseDefaults {
  return read(new URL("base-defaults.json", dir), "base") as BaseDefaults;
}

const versionFile = /^([1-9][0-9]*)\.json$/;

/**
 * The catalog (plan 5.8): every `<agenturKey>/<version>.json` under `dir`, validated through
 * `loadTemplate`, in key and version order, with the canonical hash of the file (R22). Files
 * beside the key directories (the manifest itself) are skipped; any other file in a key
 * directory is an error.
 */
export function buildManifest(dir: URL = templatesDir): TemplateManifest {
  const templates = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap(({ name: agenturKey }) =>
      readdirSync(new URL(`${agenturKey}/`, dir)).map((file) => {
        const match = versionFile.exec(file);
        if (!match) {
          throw new ConfigError(`${agenturKey}/${file}`, [{ code: "invalid_reference", path: [] }]);
        }
        const version = Number(match[1]);
        const { label, sample = false } = loadTemplate(agenturKey, version, dir);
        const sha256 = canonicalHash(readJson(new URL(`${agenturKey}/${file}`, dir)));
        return { agenturKey, version, label, sample, sha256 };
      }),
    )
    .toSorted(compareTemplateVersions);
  return { templates };
}

/** `templates/manifest.json` as `pnpm generate` writes it. */
export function renderManifest(dir: URL = templatesDir): string {
  return `${JSON.stringify(buildManifest(dir), null, 2)}\n`;
}

/** The committed catalog of `dir` (the API reads it from `CONFIG_DIR` in the image). */
export function loadManifest(dir: URL = templatesDir): TemplateManifest {
  return TemplateManifest.parse(readJson(new URL("manifest.json", dir)));
}

function readJson(file: URL): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

function read(file: URL, name: string) {
  const result = parseLayer(readJson(file));
  if (!result.ok) throw new ConfigError(name, result.issues);
  return result.layer;
}
