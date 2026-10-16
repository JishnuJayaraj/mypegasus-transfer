import { expect, it } from "vitest";
import { AccessCategory } from "../fields/catalog";
import { renderAccessMatrixDoc } from "./matrix-doc";
import { accessProfiles } from "./profiles";

it("renders every subject, category and undecided cell (docs/domain/generated/access-matrix.md)", () => {
  const doc = renderAccessMatrixDoc();
  const section = (heading: string) => doc.split(`## ${heading}\n`)[1]!.split("\n## ")[0]!;
  const rows = (heading: string) =>
    section(heading)
      .split("\n")
      .filter((l) => l.startsWith("| ") && !/^\| (Subject|Question|---) /.test(l));

  expect(doc).toMatch(/^# Access matrix \(generated\)\n/);
  const full = accessProfiles.length * AccessCategory.options.length;
  expect(rows("Active phase, normal mode")).toHaveLength(full);
  expect(rows("Evidence-set phase, normal mode")).toHaveLength(full);
  expect(section("Evidence-set phase, assisted mode")).toContain(
    "No cell differs from normal mode.",
  );
  expect(doc).toContain(
    "| PL | `health` | no: needs_assisted_mode | no: not_in_list_payloads | no: needs_assisted_mode | no: needs_assisted_mode |",
  );
  expect(doc).toContain(
    "| PL | `health` | `read` | no: needs_assisted_mode | yes · break_glass_access · grant · review |",
  );
  expect(doc).toContain(
    "| Consultant/profiler (assigned) | `signed_tl407` | metadata_only | no: not_in_list_payloads | yes · document_opened | no: immutable |",
  );
  expect(doc).toContain(
    "| Q65 | PL | `confidential` | `write` | active normal, active break_glass, evidence_set normal, evidence_set assisted, evidence_set break_glass |",
  );
  expect(rows("Undecided cells").every((r) => /^\| Q(65|87) \|/.test(r))).toBe(true);
  expect(doc.endsWith("\n")).toBe(true);
});
