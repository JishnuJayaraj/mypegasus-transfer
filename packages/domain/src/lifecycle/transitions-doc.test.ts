import { expect, it } from "vitest";
import { fieldCorrectionAuthority } from "../access/corrections";
import { OperationKind } from "../access/permissions";
import { DocumentType } from "../documents/catalog";
import { edges } from "./edges";
import { guardIds } from "./guards";
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
          !/^\| (Guard|Operation|Target) \|/.test(line),
      );

  expect(doc).toMatch(/^# Lifecycle transitions \(generated\)\n/);
  expect(rows("Edges")).toHaveLength(edges.length);
  expect(rows("Guards")).toHaveLength(guardIds.length);
  expect(rows("Operations without a status change")).toHaveLength(
    OperationKind.options.length +
      DocumentType.options.length +
      Object.keys(fieldCorrectionAuthority).length,
  );
  expect(doc).toContain(
    "| main | `active_in_tg` | `exited` | user | manual | Consultant/profiler (assigned), PL | — | all |",
  );
  expect(doc).toContain("| `decideProfilingException` | Regional operations manager |");
  expect(doc).toContain("| `requestEvidenceCorrection` | PL, Back office | — |");
  expect(doc).toContain("| document | `asu_proof` | PL |");
  expect(doc).toContain("| field | `tgEntryDate` | PL, Back office |");
  expect(doc).toContain("| main | *(create)* | `imported` | user | manual | PL | — | all |");
  expect(doc).toContain(
    "| dsv | `dsv_expired` | `dsv_offered` | user | manual | PL, Back office | `before_cutoff`, `offer_deadline_valid` | all |",
  );
  expect(doc).toContain(
    "| main | `informed` | `ta_completed` | user | manual | PL | `ta_completion` | ta_only |",
  );
  expect(doc).toContain("| `ta_completion` | main `informed` → `ta_completed` |");
  // Every edge and operation names who may take it; an empty cell would be a rule nobody can use.
  expect(doc).not.toMatch(/\|[ \t]*\|/);
  expect(doc.endsWith("\n")).toBe(true);
});
