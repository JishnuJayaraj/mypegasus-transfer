import { writeFileSync } from "node:fs";
import { renderJsonSchema } from "../src/json-schema";

// `pnpm generate` writes the JSON Schema of the configuration layers; CI fails on drift.
writeFileSync(
  new URL("../schema/regional-template.schema.json", import.meta.url),
  renderJsonSchema(),
);
