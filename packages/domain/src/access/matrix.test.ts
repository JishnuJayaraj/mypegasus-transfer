import { describe, expect, it } from "vitest";
import { DocumentType } from "../documents/catalog";
import { AccessCategory } from "../fields/catalog";
import { AuditStream, decideAccess, type AccessAction, type Resource } from "./decide";
import {
  accessModes,
  accessProfiles,
  fieldCategories,
  sampleAggregate,
  sampleAudit,
  sampleDocument,
  sampleField,
} from "./profiles";
import { cell } from "./testing/cell";

// Active phase, normal mode: data-protection.md's read matrix and write table and round 11,
// restated by hand. Columns: participant (birth-date check passed), participant (no
// check), consultant (assigned), consultant (not assigned), PL, back office, regional
// operations manager, regional admin, admin. Field rows use a self-service field where the
// category has one (participant writes, Q65); staff write those in assisted mode only (Q136).
//   yes = full view, sr/sw = sensitive_read/sensitive_write, meta = metadata only,
//   opened = full view, document_opened, abs = "abwesend" + dates, type = type + dates
const fieldRead = `
case_internal        yes   yes   yes   unass yes    yes   never never never
confidential         yes   yes   yes   unass yes    yes   never never never
health               sr    check sr    unass assist never never never never
disability           sr    check sr    unass assist sr    never never never
identifiers          sr    sr    sr    unass never  sr    never never never
residence_social     sr    sr    sr    unass never  sr    never never never
profiling_assessment never never sr    unass never  never never never never
absence              type  type  abs   unass abs    type  never never never`;

const fieldWrite = `
case_internal        never never op    unass op     op    never never never
confidential         yes   yes   yes   unass assist assist never never never
health               sw    check sw    unass assist never never never never
disability           sw    check sw    unass assist sw    never never never
identifiers          sw    sw    assist unass never sw    never never never
residence_social     sw    sw    assist unass never assist never never never
profiling_assessment never never sw    unass never  never never never never
absence              never never never unass never  yes   never never never`;

// Q87 B (round 11): the document-type catalog.
const documentRead = `
tl407_signed_scan            never never meta  unass meta   never never never never
kug200b_signed_scan          never never meta  unass meta   never never never never
dsv_signed_scan              never never never unass meta   meta  never never never
dsv_cancellation             never never never unass meta   meta  never never never
asu_proof                    never never meta  unass meta   never never never never
profiling_exception_evidence never never meta  unass assist never meta  never never
cv                           meta  meta  meta  unass meta   never never never never
participant_upload           meta  meta  meta  unass meta   never never never never
qualification_certificate    meta  meta  meta  unass meta   never never never never
tl407_form                   never never meta  unass meta   never never never never`;

const documentOpen = `
tl407_signed_scan            never  never  opened unass opened never  never never never
kug200b_signed_scan          never  never  opened unass opened never  never never never
dsv_signed_scan              never  never  never  unass opened opened never never never
dsv_cancellation             never  never  never  unass opened opened never never never
asu_proof                    never  never  opened unass bg     never  never never never
profiling_exception_evidence never  never  opened unass assist never  never never never
cv                           opened opened opened unass opened never  never never never
participant_upload           opened opened opened unass opened never  never never never
qualification_certificate    opened opened opened unass opened never  never never never
tl407_form                   never  never  opened unass opened never  never never never`;

const documentWrite = `
tl407_signed_scan            never never imm   unass imm   never never never never
kug200b_signed_scan          never never imm   unass imm   never never never never
dsv_signed_scan              never never never unass imm   imm   never never never
dsv_cancellation             never never never unass imm   imm   never never never
asu_proof                    never never imm   unass imm   never never never never
profiling_exception_evidence never never op    unass op    never never never never
cv                           op    op    op    unass op    never never never never
participant_upload           op    op    op    unass op    never never never never
qualification_certificate    op    op    op    unass op    never never never never
tl407_form                   never never imm   unass imm   never never never never`;

// Q87 A (round 11): filtered audit projections; events of another staff user.
const auditRead = `
case      never never yes   unass yes   never never never never
profiling never never yes   unass yes   never never never never
dsv       never never never unass yes   yes   never never never
payroll   never never never unass never yes   never never never
security  never never never unass never never never never never
review    never never never unass never never yes   never never`;

const aggregateRead = "aggregate never never yes yes yes yes yes yes yes";

const codes: Record<string, string> = {
  yes: "allow full",
  sr: "allow full sensitive_read",
  sw: "allow full sensitive_write",
  meta: "allow metadata_only",
  opened: "allow full document_opened",
  abs: "allow absence_only",
  type: "allow type_and_dates",
  never: "deny never",
  unass: "deny not_assigned",
  check: "deny needs_knowledge_check",
  assist: "deny needs_assisted_mode",
  bg: "deny needs_break_glass",
  op: "deny via_domain_operation",
  imm: "deny immutable",
};

function cases(table: string, action: AccessAction, resource: (row: string) => Resource) {
  return table
    .trim()
    .split("\n")
    .flatMap((line) => {
      const [row, ...expected] = line.trim().split(/\s+/);
      expect(expected).toHaveLength(accessProfiles.length);
      return accessProfiles.map(
        (p, i) => [p.key, row!, action, codes[expected[i]!], resource(row!)] as const,
      );
    });
}

const rows = (table: string) =>
  table
    .trim()
    .split("\n")
    .map((l) => l.split(" ")[0]);
const field = (row: string) => sampleField(AccessCategory.parse(row), "active");
const document = (row: string) => sampleDocument(DocumentType.parse(row), "active");

describe("access matrix, active phase, normal mode (data-protection.md)", () => {
  it("restates every field category, document type and audit stream", () => {
    expect(rows(fieldRead)).toEqual(fieldCategories);
    expect(rows(fieldWrite)).toEqual(fieldCategories);
    for (const table of [documentRead, documentOpen, documentWrite]) {
      expect(rows(table)).toEqual(DocumentType.options);
    }
    expect(rows(auditRead)).toEqual(AuditStream.options);
  });

  it.each([
    ...cases(fieldRead, "read", field),
    ...cases(fieldWrite, "write", field),
    ...cases(documentRead, "read", document),
    ...cases(documentOpen, "open_document", document),
    ...cases(documentWrite, "write", document),
    ...cases(auditRead, "read", (row) => sampleAudit(AuditStream.parse(row), "staff-other")),
    ...cases(aggregateRead, "read", () => sampleAggregate()),
  ])("%s %s %s: %s", (key, _row, action, expected, resource) => {
    const { subject } = accessProfiles.find((p) => p.key === key)!;
    expect(cell(decideAccess(subject, resource, action, accessModes.normal))).toBe(expected);
  });
});
