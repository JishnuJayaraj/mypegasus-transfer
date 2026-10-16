import { expect, it } from "vitest";
import { edges } from "./edges";
import { guardIds } from "./guards";
import { operationFailures } from "./operations";
import { renderTransitionsDoc } from "./transitions-doc";

it("renders every edge, guard and operation (docs/domain/generated/lifecycle-transitions.md)", () => {
  const doc = renderTransitionsDoc();
  const rows = (heading: string) =>
    doc
      .split(`## ${heading}\n`)[1]!
      .split("\n## ")[0]!
      .split("\n")
      .filter(
        (line) =>
          line.startsWith("| ") &&
          !line.startsWith("| Track") &&
          !/^\| (Guard|Operation) \|/.test(line),
      );

  expect(doc).toMatch(/^# Lifecycle transitions \(generated\)\n/);
  expect(rows("Edges")).toHaveLength(edges.length);
  expect(rows("Guards")).toHaveLength(guardIds.length);
  expect(rows("Operations without a status change")).toHaveLength(
    Object.keys(operationFailures).length,
  );
  expect(doc).toContain("| main | *(create)* | `imported` | user | manual | — | all |");
  expect(doc).toContain(
    "| dsv | `dsv_expired` | `dsv_offered` | user | manual | `before_cutoff`, `offer_deadline_valid` | all |",
  );
  expect(doc).toContain(
    "| main | `informed` | `ta_completed` | user | manual | `ta_completion` | ta_only |",
  );
  expect(doc).toContain("| `ta_completion` | main `informed` → `ta_completed` |");
  expect(doc.endsWith("\n")).toBe(true);
});
