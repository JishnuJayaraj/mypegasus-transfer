import { describe, expect, it } from "vitest";
import { DocumentType, documentTypeCatalog, documentTypeEntry } from "./catalog";
import { uploadableDocumentTypes } from "./api";

describe("document-type catalog (round 11, Q87 B)", () => {
  it("has exactly one entry per type", () => {
    expect(documentTypeCatalog.types.map((t) => t.type)).toEqual(DocumentType.options);
    for (const type of DocumentType.options) expect(documentTypeEntry(type).type).toBe(type);
  });

  it("keeps signed documents out of the portal (Q67, round 11)", () => {
    for (const entry of documentTypeCatalog.types.filter((t) => t.signed)) {
      expect([entry.type, "participant" in entry.roles]).toEqual([entry.type, false]);
    }
    const visible = documentTypeCatalog.types.filter((t) => "participant" in t.roles);
    expect(visible.map((t) => t.type)).toEqual([
      "cv",
      "participant_upload",
      "qualification_certificate",
    ]);
  });

  it("gives every type a category, class and retention class", () => {
    expect(documentTypeCatalog.version).toBe(6);
    for (const entry of documentTypeCatalog.types) {
      expect(entry.accessCategory).toBeTruthy();
      expect(entry.dataClass).toBeTruthy();
      expect([
        "evidence_set",
        "personnel_file",
        "participation_record",
        "form_working_copy",
      ]).toContain(entry.retentionClass);
    }
  });
});

describe("document-type catalog version 2 (Q142, Q145, Q146, Q148)", () => {
  const own = ["cv", "participant_upload", "qualification_certificate"];

  it("gives the participant's own documents personnel-file retention, file names and operations", () => {
    for (const type of own) {
      const entry = documentTypeEntry(DocumentType.parse(type));
      expect([type, entry.retentionClass, entry.fileName]).toEqual([type, "personnel_file", true]);
      expect(entry.operations).toEqual({
        add: ["participant", "consultant", "project_lead"],
        review: ["consultant", "project_lead"],
        delete: ["participant", "consultant", "project_lead"],
      });
    }
  });

  it("leaves the other types' operations undecided and keeps no file name (Q65)", () => {
    const others = documentTypeCatalog.types.filter(
      (t) =>
        !own.includes(t.type) &&
        ![
          "tl407_form",
          "tl407_signed_scan",
          "asu_proof",
          "kug200b_form",
          "kug200b_signed_scan",
        ].includes(t.type),
    );
    for (const entry of others) {
      expect([entry.type, entry.operations, entry.fileName]).toEqual([
        entry.type,
        "undecided",
        false,
      ]);
    }
  });
});

describe("document-type catalog version 3 (Q179)", () => {
  it("adds the generated TL 407: the signed type's category and class, its own retention", () => {
    const form = documentTypeEntry("tl407_form");
    const signed = documentTypeEntry("tl407_signed_scan");
    expect(form).toMatchObject({
      accessCategory: signed.accessCategory,
      dataClass: signed.dataClass,
      roles: signed.roles,
      retentionClass: "form_working_copy",
      signed: false,
      fileName: false,
      operations: "generated",
    });
    expect(uploadableDocumentTypes).not.toContain("tl407_form");
  });
});

describe("document-type catalog version 4 (Q183, Q184)", () => {
  it("gives the signed TL 407 its operations: add and review by the PL and the consultant, delete by the PL", () => {
    expect(documentTypeEntry("tl407_signed_scan")).toMatchObject({
      signed: true,
      fileName: false,
      retentionClass: "evidence_set",
      operations: {
        add: ["consultant", "project_lead"],
        review: ["consultant", "project_lead"],
        delete: ["project_lead"],
      },
    });
  });
});

describe("document-type catalog version 5 (Q186)", () => {
  it("gives the ASU proof its operations: added by the consultant and the PL, reviewed by the consultant, deleted by the PL", () => {
    expect(documentTypeEntry("asu_proof")).toMatchObject({
      signed: true,
      fileName: false,
      retentionClass: "participation_record",
      roles: { consultant: "open", project_lead: "metadata_break_glass_open" },
      operations: {
        add: ["consultant", "project_lead"],
        review: ["consultant"],
        delete: ["project_lead"],
      },
    });
  });
});

describe("document-type catalog version 6 (Q179, Q184)", () => {
  it("adds the generated Kug 200b: the signed type's category, class and roles, its own retention", () => {
    const form = documentTypeEntry("kug200b_form");
    const signed = documentTypeEntry("kug200b_signed_scan");
    expect(form).toMatchObject({
      accessCategory: signed.accessCategory,
      dataClass: signed.dataClass,
      roles: signed.roles,
      retentionClass: "form_working_copy",
      signed: false,
      fileName: false,
      operations: "generated",
    });
  });

  it("gives the signed Kug 200b the signed TL 407's operations (Q184)", () => {
    expect(documentTypeEntry("kug200b_signed_scan").operations).toEqual(
      documentTypeEntry("tl407_signed_scan").operations,
    );
    expect("back_office" in documentTypeEntry("kug200b_signed_scan").roles).toBe(false);
  });
});
