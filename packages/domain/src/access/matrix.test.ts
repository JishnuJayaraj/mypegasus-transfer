import { describe, expect, it } from "vitest";
import { AccessCategory } from "../fields/catalog";
import { decideAccess, type AccessAction } from "./decide";
import { accessModes, accessProfiles, sampleResource } from "./profiles";
import { cell } from "./testing/cell";

// Active phase, normal mode: data-protection.md's read matrix and write table, plan 5.6,
// restated by hand. Columns: participant (birth-date check passed), participant (no check),
// consultant (assigned), consultant (not assigned), PL, back office, regional operations
// manager, regional admin, admin. Participant writes name a self-service field (Q65).
//   yes = full view, sr/sw = sensitive_read/sensitive_write, meta = metadata only,
//   abs = "abwesend" + dates, type = type + dates, Qnn = undecided (docs gap, D10)
const read = `
case_internal        yes   yes   yes   unass yes    yes   never never never
confidential         yes   yes   yes   unass yes    yes   never never never
health               sr    check sr    unass assist never never never never
disability           sr    check sr    unass assist sr    never never never
identifiers          sr    sr    sr    unass never  sr    never never never
residence_social     sr    sr    sr    unass never  sr    never never never
profiling_assessment never never sr    unass never  never never never never
signed_tl407         never never meta  unass meta   never never never never
signed_kug200b       never never meta  unass meta   never never never never
absence              type  type  abs   unass abs    type  never never never
audit_metadata       Q87   Q87   Q87   Q87   Q87    Q87   yes   never never
aggregated           never never yes   yes   yes    yes   yes   yes   yes`;

const write = `
case_internal        never never fn    unass fn     fn    never never never
confidential         yes   yes   yes   unass Q65    Q65   never never never
health               sw    check sw    unass assist never never never never
disability           sw    check sw    unass assist sw    never never never
identifiers          sw    sw    Q65   unass never  sw    never never never
residence_social     sw    sw    Q65   unass never  Q65   never never never
profiling_assessment never never sw    unass never  never never never never
signed_tl407         never never imm   unass imm    imm   never never never
signed_kug200b       never never imm   unass imm    imm   never never never
absence              never never never unass never  yes   never never never
audit_metadata       never never never never never  never never never never
aggregated           never never never never never  never never never never`;

const codes: Record<string, string> = {
  yes: "allow full",
  sr: "allow full sensitive_read",
  sw: "allow full sensitive_write",
  meta: "allow metadata_only",
  abs: "allow absence_only",
  type: "allow type_and_dates",
  never: "deny never",
  unass: "deny not_assigned",
  check: "deny needs_knowledge_check",
  assist: "deny needs_assisted_mode",
  fn: "deny via_status_functions",
  imm: "deny immutable",
  Q65: "deny undecided Q65",
  Q87: "deny undecided Q87",
};

function cases(table: string, action: AccessAction) {
  return table
    .trim()
    .split("\n")
    .flatMap((line) => {
      const [category, ...expected] = line.trim().split(/\s+/);
      expect(expected).toHaveLength(accessProfiles.length);
      return accessProfiles.map((p, i) => [p.key, category!, action, codes[expected[i]!]] as const);
    });
}

describe("access matrix, active phase, normal mode (AC-23)", () => {
  it("restates every category", () => {
    for (const table of [read, write]) {
      const categories = table
        .trim()
        .split("\n")
        .map((l) => l.split(" ")[0]);
      expect(categories).toEqual(AccessCategory.options);
    }
  });

  it.each([...cases(read, "read"), ...cases(write, "write")])(
    "%s %s %s: %s",
    (key, category, action, expected) => {
      const { subject } = accessProfiles.find((p) => p.key === key)!;
      const resource = sampleResource(AccessCategory.parse(category), "active");
      expect(cell(decideAccess(subject, resource, action, accessModes.normal))).toBe(expected);
    },
  );
});
