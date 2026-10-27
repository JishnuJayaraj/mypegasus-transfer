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
    expect(documentTypeCatalog.version).toBe(4);
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
      (t) => !own.includes(t.type) && t.type !== "tl407_form" && t.type !== "tl407_signed_scan",
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
