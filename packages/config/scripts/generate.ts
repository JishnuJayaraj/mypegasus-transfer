import { writeFileSync } from "node:fs";
import { renderJsonSchema } from "../src/json-schema";
import { renderManifest, templatesDir } from "../src/load";

// `pnpm generate` writes the JSON Schema of the configuration layers and the template manifest
// (Slice 2 plan 5.8); CI fails on drift.
writeFileSync(
  new URL("../schema/regional-template.schema.json", import.meta.url),
  renderJsonSchema(),
);
writeFileSync(new URL("manifest.json", templatesDir), renderManifest());
