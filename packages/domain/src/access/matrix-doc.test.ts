import { expect, it } from "vitest";
import { DocumentType } from "../documents/catalog";
import { AuditStream } from "./decide";
import { asUndecided, cellText, renderAccessMatrixDoc, undecidedTable } from "./matrix-doc";
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
    "| PL | `confidential` | `write` | no: needs_assisted_mode | yes |",
  );
  // The sampled self-service fields are decided (Q136); Q65 holds for the others.
  expect(part("## Undecided cells")).toContain("No sampled cell is undecided.");
  expect(doc.endsWith("\n")).toBe(true);
});

it("lists an undecided cell once, with every phase and mode it is undecided in", () => {
  const text = cellText({ effect: "deny", because: "undecided", question: "Q65" });
  const rendered = { label: "PL", staff: true, key: "confidential", action: "write", text } as const;
  expect(asUndecided({ ...rendered, text: "no: never" }, "active normal")).toEqual([]);
  const [cell] = asUndecided(rendered, "active normal");
  expect(cell).toEqual({ question: "Q65", label: "PL", key: "confidential", action: "write", where: "active normal" });
  expect(
    undecidedTable([
      { ...cell, where: "active normal" },
      { ...cell, where: "active break_glass" },
    ]).split("\n")[2],
  ).toBe("| Q65 | PL | `confidential` | `write` | active normal, active break_glass |");
});
