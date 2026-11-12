import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sourcesFolder } from "../function-sources";
import { renderGeneratedSources } from "../generated-sources";

// ADR-0002, generated lists: writes the generated function and trigger sources. `pnpm verify`
// fails when the committed files differ from this output.
for (const [name, content] of Object.entries(renderGeneratedSources())) {
  mkdirSync(dirname(join(sourcesFolder, name)), { recursive: true });
  writeFileSync(join(sourcesFolder, name), content);
}
