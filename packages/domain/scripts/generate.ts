import { writeFileSync } from "node:fs";
import { renderAccessMatrixDoc } from "../src/access/matrix-doc";
import { renderTransitionsDoc } from "../src/lifecycle/transitions-doc";

// `pnpm generate` writes the generated docs tables; CI fails when they differ from the code.
const generated = (name: string) =>
  new URL(`../../../docs/domain/generated/${name}`, import.meta.url);
writeFileSync(generated("lifecycle-transitions.md"), renderTransitionsDoc());
writeFileSync(generated("access-matrix.md"), renderAccessMatrixDoc());
