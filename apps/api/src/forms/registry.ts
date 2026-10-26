import { createTextMeasure } from "@transfer/adapters";
import {
  formVersionInUse,
  type FormCode,
  type HtmlTemplate,
  type IsoDate,
  type TextMeasure,
} from "@transfer/domain";
import {
  fontsDir,
  formsDir,
  listFormVersions,
  loadFont,
  loadFormVersion,
  loadOwnTemplate,
  type FormVersionFiles,
} from "@transfer/forms/load";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// The form registry as the API uses it (ADR-0009): every committed version, checked by hash when
// loaded, the own templates and the embedded font. With CONFIG_DIR (the bundle and the image) the
// copy in `<CONFIG_DIR>/forms/`, else the repo's `packages/forms`. Loaded on first use, so a
// configuration directory without forms fails only what needs them.

export type FormRegistry = {
  font(): Uint8Array;
  /** The version in use on `today` (regional-variation.md, forms are versioned), or null. */
  inUse(formCode: FormCode, today: IsoDate): FormVersionFiles | null;
  /** Whether a committed version is in use on `today`. */
  versionInUse(formCode: FormCode, version: string, today: IsoDate): boolean;
  template(ref: string): HtmlTemplate;
  /** The font's text metrics for the layout (measured once). */
  measure(): Promise<TextMeasure>;
};

const loaded = new Map<string, FormRegistry>();

const dirs = (configDir: string | undefined) =>
  configDir === undefined
    ? { forms: formsDir, fonts: fontsDir }
    : {
        forms: pathToFileURL(join(configDir, "forms", "templates") + "/"),
        fonts: pathToFileURL(join(configDir, "forms", "fonts") + "/"),
      };

/** The registry of the configuration directory, loaded once per process on first use. */
export function formRegistry(configDir: string | undefined): FormRegistry {
  const key = configDir ?? "";
  const cached = loaded.get(key);
  if (cached) return cached;
  const { forms, fonts } = dirs(configDir);
  let entries: (FormVersionFiles["manifest"] & { files: FormVersionFiles })[] | undefined;
  const versions = () =>
    (entries ??= listFormVersions(forms).map(({ formCode, version }) => {
      const files = loadFormVersion(formCode, version, forms);
      return { ...files.manifest, files };
    }));
  let font: Uint8Array | undefined;
  const templates = new Map<string, HtmlTemplate>();
  let measure: Promise<TextMeasure> | undefined;
  const registry: FormRegistry = {
    font: () => (font ??= loadFont(fonts)),
    inUse: (formCode, today) => formVersionInUse(versions(), formCode, today)?.files ?? null,
    versionInUse: (formCode, version, today) =>
      formVersionInUse(versions(), formCode, today)?.version === version,
    template(ref) {
      let template = templates.get(ref);
      if (!template) templates.set(ref, (template = loadOwnTemplate(ref, forms)));
      return template;
    },
    measure: () => (measure ??= createTextMeasure(registry.font())),
  };
  loaded.set(key, registry);
  return registry;
}
