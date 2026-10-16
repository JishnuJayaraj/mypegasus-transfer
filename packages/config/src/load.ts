import { readFileSync } from "node:fs";
import { AgenturKey, type BaseDefaults, type RegionalTemplate } from "./model";
import { ConfigError, parseLayer, type ConfigIssue } from "./validate";

// Node only (reads files): exported as `@transfer/config/load`, never from the package root,
// which the SPAs may import.

/** The seed templates: `templates/<agenturKey>/<version>.json` (MVP, ADR-0004). */
export const templatesDir = new URL("../templates/", import.meta.url);
const baseDefaultsFile = new URL("../../domain/config/base-defaults.json", import.meta.url);

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
export function loadBaseDefaults(): BaseDefaults {
  return read(baseDefaultsFile, "base") as BaseDefaults;
}

function read(file: URL, name: string) {
  const result = parseLayer(JSON.parse(readFileSync(file, "utf8")));
  if (!result.ok) throw new ConfigError(name, result.issues);
  return result.layer;
}
