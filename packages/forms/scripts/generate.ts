import { writeFileSync } from "node:fs";
import { formsDir, renderFormsManifest } from "../src/load";

// `pnpm generate` writes the forms manifest from the version folders (ADR-0009); CI fails on drift.
writeFileSync(new URL("manifest.json", formsDir), renderFormsManifest());
