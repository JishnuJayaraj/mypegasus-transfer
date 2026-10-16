import { writeFileSync } from "node:fs";
import { renderTransitionsDoc } from "../src/lifecycle/transitions-doc";

// `pnpm generate` writes the generated docs tables; CI fails when they differ from the code.
writeFileSync(
  new URL("../../../docs/domain/generated/lifecycle-transitions.md", import.meta.url),
  renderTransitionsDoc(),
);
