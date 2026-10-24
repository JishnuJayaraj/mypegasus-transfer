import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { FieldMap, FormCode, FormVersionManifest, type HtmlTemplate } from "@transfer/domain";
import { FormSource, FormsManifest } from "./manifest";

// Node only (reads files): exported as `@transfer/forms/load`. The registry (ADR-0009):
// `templates/ba/<formCode>/<version>/` holds the BA's unchanged `blank.pdf`, its `source.json`
// (provenance), our `manifest.json` (effective dates, SHA-256) and `field-map.json`;
// `templates/own/<name>/v<n>/` our HTML templates; `fonts/` the embedded Noto Sans subset.

export const formsDir = new URL("../templates/", import.meta.url);
export const fontsDir = new URL("../fonts/", import.meta.url);

export class FormRegistryError extends Error {
  constructor(
    readonly path: string,
    readonly code: "path_mismatch" | "hash_mismatch" | "unknown_template",
  ) {
    super(`${path}: ${code}`);
    this.name = "FormRegistryError";
  }
}

export const sha256Hex = (content: Uint8Array) =>
  createHash("sha256").update(content).digest("hex");

const readJson = (file: URL): unknown => JSON.parse(readFileSync(file, "utf8"));
const directories = (dir: URL) =>
  readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted();

export type FormVersionFiles = {
  manifest: FormVersionManifest;
  source: FormSource;
  fieldMap: FieldMap;
  blank: Uint8Array;
};

/**
 * One version folder: each file parsed, each naming the form and version its path names, and the
 * blank's SHA-256 equal to the manifest's and the source's.
 */
export function loadFormVersion(
  formCode: string,
  version: string,
  dir = formsDir,
): FormVersionFiles {
  const path = `ba/${formCode}/${version}`;
  const folder = new URL(`${path}/`, dir);
  const manifest = FormVersionManifest.parse(readJson(new URL("manifest.json", folder)));
  const source = FormSource.parse(readJson(new URL("source.json", folder)));
  const fieldMap = FieldMap.parse(readJson(new URL("field-map.json", folder)));
  for (const named of [manifest, source, fieldMap]) {
    if (named.formCode !== formCode || named.version !== version) {
      throw new FormRegistryError(path, "path_mismatch");
    }
  }
  const blank = new Uint8Array(readFileSync(new URL("blank.pdf", folder)));
  const hash = sha256Hex(blank);
  if (hash !== manifest.sha256 || hash !== source.sha256) {
    throw new FormRegistryError(path, "hash_mismatch");
  }
  return { manifest, source, fieldMap, blank };
}

/** Every version folder, by form code and version. */
export function listFormVersions(dir = formsDir): { formCode: FormCode; version: string }[] {
  const ba = new URL("ba/", dir);
  return directories(ba).flatMap((formCode) =>
    directories(new URL(`${formCode}/`, ba)).map((version) => ({
      formCode: FormCode.parse(formCode),
      version,
    })),
  );
}

const templateFiles = ["index.html", "header.html", "footer.html"] as const;

/** Every own template version, `<name>:v<n>`. */
export function listOwnTemplates(dir = formsDir): string[] {
  const own = new URL("own/", dir);
  return directories(own).flatMap((name) =>
    directories(new URL(`${name}/`, own)).map((version) => `${name}:${version}`),
  );
}

/** The forms manifest as `pnpm generate` writes it. */
export function buildFormsManifest(dir = formsDir): FormsManifest {
  return {
    forms: listFormVersions(dir).map(({ formCode, version }) => {
      const { manifest, source, fieldMap } = loadFormVersion(formCode, version, dir);
      return {
        formCode,
        version,
        label: fieldMap.label,
        validFrom: manifest.validFrom,
        validUntil: manifest.validUntil,
        sha256: manifest.sha256,
        pages: source.pages,
        fields: source.acroFormFields,
      };
    }),
    templates: listOwnTemplates(dir).map((ref) => {
      const folder = templateFolder(ref, dir);
      const files = Object.fromEntries(
        templateFiles.map((file) => [file, sha256Hex(readFileSync(new URL(file, folder)))]),
      );
      return { ref, files };
    }),
  };
}

export function renderFormsManifest(dir = formsDir): string {
  return `${JSON.stringify(buildFormsManifest(dir), null, 2)}\n`;
}

/** The committed manifest (the API reads it with the registry). */
export function loadFormsManifest(dir = formsDir): FormsManifest {
  return FormsManifest.parse(readJson(new URL("manifest.json", dir)));
}

function templateFolder(ref: string, dir: URL): URL {
  const [name, version] = ref.split(":");
  return new URL(`own/${name}/${version}/`, dir);
}

/** An own HTML template version, each file checked against the committed manifest. */
export function loadOwnTemplate(ref: string, dir = formsDir): HtmlTemplate {
  const entry = loadFormsManifest(dir).templates.find((template) => template.ref === ref);
  if (!entry) throw new FormRegistryError(ref, "unknown_template");
  const folder = templateFolder(ref, dir);
  const [index, header, footer] = templateFiles.map((file) => {
    const content = readFileSync(new URL(file, folder));
    if (sha256Hex(content) !== entry.files[file]) throw new FormRegistryError(ref, "hash_mismatch");
    return content.toString("utf8");
  }) as [string, string, string];
  return { index, header, footer };
}

/** The embedded Noto Sans subset (OFL), checked against its `source.json`. */
export function loadFont(dir = fontsDir): Uint8Array {
  const font = new Uint8Array(readFileSync(new URL("noto-sans-subset.ttf", dir)));
  const { sha256 } = readJson(new URL("source.json", dir)) as { sha256: string };
  if (sha256Hex(font) !== sha256) throw new FormRegistryError("fonts", "hash_mismatch");
  return font;
}
