import { describe, expect, it } from "vitest";
import { DocumentType, documentTypeCatalog, documentTypeEntry } from "./catalog";

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
    expect(visible.map((t) => t.type)).toEqual(["participant_upload", "qualification_certificate"]);
  });

  it("gives every type a category, class and retention class", () => {
    expect(documentTypeCatalog.version).toBe(1);
    for (const entry of documentTypeCatalog.types) {
      expect(entry.accessCategory).toBeTruthy();
      expect(entry.dataClass).toBeTruthy();
      expect(["evidence_set", "personnel_file", "participation_record"]).toContain(
        entry.retentionClass,
      );
    }
  });
});
