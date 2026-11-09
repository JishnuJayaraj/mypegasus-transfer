import { describe, expect, it, vi } from "vitest";
import type { DocumentTypeEntry } from "../documents/catalog";
import { mayAddDocument, mayDeleteDocument } from "./document-operations";
import { accessModes, accessProfiles, sample } from "./profiles";

// From catalog version 10 every type's operations are decided; the rule for a type whose slice
// hasn't decided them yet (Q65) stays for the next new type: undecided for whoever may open it,
// and a signed one is never deleted. Restated here on a catalog entry made undecided.
vi.mock("../documents/catalog", async (original) => {
  const actual = await original<typeof import("../documents/catalog")>();
  return {
    ...actual,
    documentTypeEntry: (type: Parameters<typeof actual.documentTypeEntry>[0]) => {
      const entry = actual.documentTypeEntry(type);
      return type === "dsv_cancellation"
        ? ({ ...entry, operations: "undecided" } satisfies DocumentTypeEntry)
        : entry;
    },
  };
});

const target = {
  projectId: sample.projectId,
  regionId: sample.regionId,
  participationId: sample.participationId,
};
const profile = (key: string) => accessProfiles.find((p) => p.key === key)!.subject;

describe("a type whose operations are undecided (Q65)", () => {
  it("is undecided for the roles that may open it, refused for the others", () => {
    expect(
      mayAddDocument(profile("project_lead"), "dsv_cancellation", target, accessModes.normal),
    ).toEqual({ ok: false, because: "undecided", question: "Q65" });
    expect(
      mayAddDocument(profile("consultant"), "dsv_cancellation", target, accessModes.normal),
    ).toEqual({ ok: false, because: "role_not_allowed" });
  });
  it("keeps a signed one undeletable", () => {
    expect(
      mayDeleteDocument(profile("project_lead"), "dsv_cancellation", target, accessModes.normal, {
        addedByParticipant: false,
        reviewState: "unreviewed",
      }),
    ).toEqual({ ok: false, because: "immutable" });
  });
});
