import { expect, it } from "vitest";
import { DocumentType } from "../documents/catalog";
import { AuditStream } from "./decide";
import { renderAccessMatrixDoc } from "./matrix-doc";
import { accessProfiles, fieldCategories } from "./profiles";

const rows = (text: string) =>
  text.split("\n").filter((l) => l.startsWith("| ") && !/^\| (Subject|Question|---) /.test(l));

it("renders every subject, key and undecided cell (docs/domain/generated/access-matrix.md)", () => {
  const doc = renderAccessMatrixDoc();
  const part = (heading: string, from = doc) => from.split(`${heading}\n`)[1]!.split("\n## ")[0]!;
  const firstTable = (text: string) => rows(text.split("\n### ")[0]!);
  const profiles = accessProfiles.length;

  expect(doc).toMatch(/^# Access matrix \(generated\)\n/);
  const fields = part("## Fields");
  const documents = part("## Documents");
  expect(firstTable(part("### Active phase, normal mode", fields))).toHaveLength(
    profiles * fieldCategories.length,
  );
  expect(firstTable(part("### Evidence-set phase, normal mode", documents))).toHaveLength(
    profiles * DocumentType.options.length,
  );
  expect(part("### Evidence-set phase, assisted mode", fields)).toContain(
    "No cell differs from normal mode.",
  );
  expect(rows(part("## Audit metadata"))).toHaveLength(profiles * AuditStream.options.length);
  expect(rows(part("## Aggregates"))).toHaveLength(profiles);
  expect(doc).toContain(
    "| PL | `health` | no: needs_assisted_mode | no: not_in_list_payloads | no: needs_assisted_mode |",
  );
  expect(doc).toContain(
    "| PL | `health` | `read` | no: needs_assisted_mode | yes · break_glass_access · grant · review |",
  );
  expect(doc).toContain(
    "| Consultant/profiler (assigned) | `tl407_signed_scan` | metadata_only | no: not_in_list_payloads | yes · document_opened | no: immutable |",
  );
  expect(doc).toContain(
    "| Q65 | PL | `confidential` | `write` | active normal, active break_glass |",
  );
  expect(rows(part("## Undecided cells")).every((r) => r.startsWith("| Q65 |"))).toBe(true);
  expect(doc.endsWith("\n")).toBe(true);
});
