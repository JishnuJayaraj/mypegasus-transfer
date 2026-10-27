import { describe, expect, it } from "vitest";
import { DocumentType } from "../documents/catalog";
import type { AccessMode, Subject } from "./decide";
import { DocumentDeleteReason } from "../documents/state";
import {
  documentDeleteReasons,
  mayAddDocument,
  mayDeleteDocument,
  mayLiftDocumentQuarantine,
  mayQuarantineDocument,
  mayReviewDocument,
  type DocumentPermission,
} from "./document-operations";
import { accessModes, accessProfiles, sample } from "./profiles";

// Document operations in normal mode (data-protection.md, documents; Q146 *assumed*), restated
// by hand. Columns as in matrix.test.ts: participant (birth-date check passed), participant (no
// check), consultant (assigned), consultant (not assigned), PL, back office, regional operations
// manager, regional admin, admin. The participant deletes their own upload, not accepted; staff
// delete an unreviewed document.
//   yes = allowed, und = undecided (Q65), actor = actor_not_allowed, role = role_not_allowed,
//   unass = not_assigned, imm = immutable. A generated form comes only from its generation.
const add = `
tl407_signed_scan            actor actor yes  unass yes  role role role role
kug200b_signed_scan          actor actor und  unass und  role role role role
dsv_signed_scan              actor actor role role  und  und  role role role
dsv_cancellation             actor actor role role  und  und  role role role
asu_proof                    actor actor und  unass und  role role role role
profiling_exception_evidence actor actor und  unass und  role role role role
cv                           yes   yes   yes  unass yes  role role role role
participant_upload           yes   yes   yes  unass yes  role role role role
qualification_certificate    yes   yes   yes  unass yes  role role role role
tl407_form                   actor actor actor actor actor actor actor actor actor`;

const review = `
tl407_signed_scan            actor actor yes  unass yes  role role role role
kug200b_signed_scan          actor actor und  unass und  role role role role
dsv_signed_scan              actor actor role role  und  und  role role role
dsv_cancellation             actor actor role role  und  und  role role role
asu_proof                    actor actor und  unass und  role role role role
profiling_exception_evidence actor actor und  unass und  role role role role
cv                           actor actor yes  unass yes  role role role role
participant_upload           actor actor yes  unass yes  role role role role
qualification_certificate    actor actor yes  unass yes  role role role role
tl407_form                   actor actor actor actor actor actor actor actor actor`;

const remove = `
tl407_signed_scan            actor actor role role  yes  role role role role
kug200b_signed_scan          imm   imm   imm  imm   imm  imm  imm  imm  imm
dsv_signed_scan              imm   imm   imm  imm   imm  imm  imm  imm  imm
dsv_cancellation             imm   imm   imm  imm   imm  imm  imm  imm  imm
asu_proof                    actor actor und  unass und  role role role role
profiling_exception_evidence actor actor und  unass und  role role role role
cv                           yes   yes   yes  unass yes  role role role role
participant_upload           yes   yes   yes  unass yes  role role role role
qualification_certificate    yes   yes   yes  unass yes  role role role role
tl407_form                   imm   imm   imm  imm   imm  imm  imm  imm  imm`;

const codes: Record<string, string> = {
  yes: "ok",
  und: "undecided Q65",
  actor: "actor_not_allowed",
  role: "role_not_allowed",
  unass: "not_assigned",
  imm: "immutable",
};

const result = (p: DocumentPermission) =>
  p.ok ? "ok" : [p.because, "question" in p && p.question].filter(Boolean).join(" ");

const target = {
  projectId: sample.projectId,
  regionId: sample.regionId,
  participationId: sample.participationId,
};
const own = { addedByParticipant: true, reviewState: "unreviewed" } as const;

type Check = (subject: Subject, type: DocumentType, mode: AccessMode) => DocumentPermission;
const checks: Record<string, Check> = {
  add: (subject, type, mode) => mayAddDocument(subject, type, target, mode),
  review: (subject, type, mode) => mayReviewDocument(subject, type, target, mode),
  delete: (subject, type, mode) => mayDeleteDocument(subject, type, target, mode, own),
};

function cases(table: string, operation: string) {
  return table
    .trim()
    .split("\n")
    .flatMap((line) => {
      const [row, ...expected] = line.trim().split(/\s+/);
      expect(expected).toHaveLength(accessProfiles.length);
      return accessProfiles.map((p, i) => [p.key, row!, operation, codes[expected[i]!]] as const);
    });
}

const profile = (key: string) => accessProfiles.find((p) => p.key === key)!.subject;

describe("document operations, normal mode (Q146)", () => {
  it("restates every document type", () => {
    for (const table of [add, review, remove]) {
      expect(
        table
          .trim()
          .split("\n")
          .map((l) => l.split(" ")[0]),
      ).toEqual(DocumentType.options);
    }
  });

  it.each([...cases(add, "add"), ...cases(review, "review"), ...cases(remove, "delete")])(
    "%s %s %s: %s",
    (key, type, operation, expected) => {
      const check = checks[operation]!;
      expect(result(check(profile(key), DocumentType.parse(type), accessModes.normal))).toBe(
        expected,
      );
    },
  );
});

describe("document operations by mode", () => {
  const pl = profile("project_lead");
  const consultant = profile("consultant");
  const backOffice = profile("back_office");
  const other = { kind: "assisted", onBehalfOf: "participation-b" } as const;

  it("adds on the participant's behalf in assisted mode, as in normal mode (Q146)", () => {
    for (const subject of [pl, consultant]) {
      expect(result(checks.add!(subject, "cv", accessModes.assisted))).toBe("ok");
      expect(result(checks.add!(subject, "cv", other))).toBe("mode_not_allowed");
    }
    expect(result(checks.add!(backOffice, "cv", accessModes.assisted))).toBe("role_not_allowed");
    expect(result(checks.add!(pl, "asu_proof", accessModes.assisted))).toBe("undecided Q65");
  });

  it("reviews and deletes in normal mode only; break-glass never writes", () => {
    for (const operation of ["review", "delete"]) {
      expect(result(checks[operation]!(pl, "cv", accessModes.assisted))).toBe("mode_not_allowed");
    }
    for (const operation of ["add", "review", "delete"]) {
      expect(result(checks[operation]!(pl, "cv", accessModes.break_glass))).toBe(
        "mode_not_allowed",
      );
    }
    // Signed documents are never deleted, in any mode (retention job only).
    expect(result(checks.delete!(pl, "dsv_signed_scan", accessModes.break_glass))).toBe(
      "immutable",
    );
  });

  it("gives participants no modes and only their own participation", () => {
    const participant = profile("participant");
    for (const operation of ["add", "delete"]) {
      expect(result(checks[operation]!(participant, "cv", accessModes.assisted))).toBe(
        "actor_not_allowed",
      );
    }
    const stranger = { ...target, participationId: "participation-b" };
    expect(result(mayAddDocument(participant, "cv", stranger, accessModes.normal))).toBe(
      "actor_not_allowed",
    );
  });
});

const deletion = (subject: Subject, addedByParticipant: boolean, accepted: boolean) =>
  result(
    mayDeleteDocument(subject, "participant_upload", target, accessModes.normal, {
      addedByParticipant,
      reviewState: accepted ? "accepted" : "unreviewed",
    }),
  );

describe("deleting a document (Q146)", () => {
  const participant = profile("participant");

  it("lets the participant delete only what they added and isn't accepted", () => {
    expect(deletion(participant, true, false)).toBe("ok");
    expect(deletion(participant, false, false)).toBe("added_by_staff");
    expect(deletion(participant, true, true)).toBe("document_accepted");
  });

  it("lets the assigned consultant and the PL delete any document of the type", () => {
    for (const key of ["consultant", "project_lead"]) {
      expect(deletion(profile(key), false, true)).toBe("ok");
      expect(deletion(profile(key), true, true)).toBe("ok");
    }
    expect(deletion(profile("consultant_unassigned"), false, false)).toBe("not_assigned");
  });
});

const quarantine = (subject: Subject, mode: AccessMode = accessModes.normal) =>
  result(mayQuarantineDocument(subject, "tl407_signed_scan", target, mode));
const lift = (subject: Subject, by: string) =>
  result(mayLiftDocumentQuarantine(subject, "tl407_signed_scan", target, accessModes.normal, by));

describe("signed scans (data-protection.md, signed scans; Q183, Q184)", () => {
  const pl = profile("project_lead");
  const consultant = profile("consultant");
  const scan = (reviewState: "unreviewed" | "accepted" | "rejected") =>
    result(
      mayDeleteDocument(pl, "tl407_signed_scan", target, accessModes.normal, {
        addedByParticipant: false,
        reviewState,
      }),
    );

  it("are added in normal mode only, never on the participant's behalf", () => {
    for (const subject of [pl, consultant]) {
      expect(result(checks.add!(subject, "tl407_signed_scan", accessModes.normal))).toBe("ok");
      expect(result(checks.add!(subject, "tl407_signed_scan", accessModes.assisted))).toBe(
        "mode_not_allowed",
      );
    }
  });

  it("are deleted by the PL before their review only, as wrong person or wrong file", () => {
    expect(scan("unreviewed")).toBe("ok");
    expect(scan("accepted")).toBe("immutable");
    expect(scan("rejected")).toBe("immutable");
    expect(documentDeleteReasons("tl407_signed_scan")).toEqual(["wrong_person", "wrong_file"]);
    expect(documentDeleteReasons("cv")).toEqual(DocumentDeleteReason.options);
  });

  it("are quarantined by the PL or the assigned consultant; lifted by whoever did, or the PL", () => {
    expect(quarantine(pl)).toBe("ok");
    expect(quarantine(consultant)).toBe("ok");
    expect(quarantine(profile("consultant_unassigned"))).toBe("not_assigned");
    expect(quarantine(profile("back_office"))).toBe("role_not_allowed");
    expect(quarantine(pl, accessModes.assisted)).toBe("mode_not_allowed");
    const consultantId = consultant.kind === "staff" ? consultant.staffUserId : "";
    expect(lift(consultant, consultantId)).toBe("ok");
    expect(lift(consultant, "someone-else")).toBe("role_not_allowed");
    expect(lift(pl, consultantId)).toBe("ok");
    expect(lift(profile("back_office"), consultantId)).toBe("role_not_allowed");
  });
});
