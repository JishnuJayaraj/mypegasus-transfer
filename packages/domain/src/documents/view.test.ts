import { describe, expect, it } from "vitest";
import { accessModes, accessProfiles, sample } from "../access/profiles";
import {
  DocumentList,
  DocumentOpening,
  DocumentReviewInput,
  DocumentUploadInput,
  uploadableDocumentTypes,
} from "./api";
import {
  addableDocumentTypes,
  documentCapabilities,
  documentsHidden,
  readableDocumentTypes,
} from "./view";

// The documents a viewer sees and what they may do with each (data-protection.md, documents;
// Q146 *assumed*), per profile of the generated matrix.
const subject = (key: string) => accessProfiles.find((p) => p.key === key)!.subject;
const target = sample;
const own = ["cv", "participant_upload", "qualification_certificate"];

describe("uploadableDocumentTypes (Q142)", () => {
  it("are the participant's own types, the only ones with decided operations", () => {
    expect(uploadableDocumentTypes).toEqual(own);
  });
});

describe("readableDocumentTypes", () => {
  it("are the types the role reads metadata of, in the mode", () => {
    expect(readableDocumentTypes(subject("participant"), target, accessModes.normal)).toEqual(own);
    expect(readableDocumentTypes(subject("consultant"), target, accessModes.normal)).toEqual([
      "tl407_signed_scan",
      "kug200b_signed_scan",
      "asu_proof",
      "profiling_exception_evidence",
      ...own,
      "tl407_form",
    ]);
    expect(readableDocumentTypes(subject("back_office"), target, accessModes.normal)).toEqual([
      "dsv_signed_scan",
      "dsv_cancellation",
    ]);
    expect(readableDocumentTypes(subject("admin"), target, accessModes.normal)).toEqual([]);
  });
});

describe("documentsHidden (ADR-0010, documents)", () => {
  it("hides them from an unassigned consultant only", () => {
    expect(documentsHidden(subject("consultant_unassigned"), target)).toBe(true);
    for (const key of ["participant", "consultant", "project_lead", "back_office", "admin"]) {
      expect(documentsHidden(subject(key), target)).toBe(false);
    }
  });
});

describe("addableDocumentTypes", () => {
  it("are the uploadable types the role adds in the mode", () => {
    expect(addableDocumentTypes(subject("participant"), target, accessModes.normal)).toEqual(own);
    expect(addableDocumentTypes(subject("project_lead"), target, accessModes.assisted)).toEqual(
      own,
    );
    expect(addableDocumentTypes(subject("back_office"), target, accessModes.normal)).toEqual([]);
    expect(addableDocumentTypes(subject("participant"), target, accessModes.assisted)).toEqual([]);
  });
});

describe("documentCapabilities", () => {
  const cv = { type: "cv", addedByParticipant: true, reviewState: "unreviewed" } as const;

  it("lets the consultant and PL open, review and delete in normal mode", () => {
    for (const key of ["consultant", "project_lead"]) {
      expect(documentCapabilities(subject(key), target, accessModes.normal, cv)).toEqual({
        open: true,
        review: true,
        delete: true,
      });
    }
  });

  it("opens only in assisted mode, and nothing for back office", () => {
    expect(documentCapabilities(subject("consultant"), target, accessModes.assisted, cv)).toEqual({
      open: true,
      review: false,
      delete: false,
    });
    expect(documentCapabilities(subject("back_office"), target, accessModes.normal, cv)).toEqual({
      open: false,
      review: false,
      delete: false,
    });
  });

  it("reviews once; the participant deletes their own while not accepted", () => {
    const participant = subject("participant");
    const pl = subject("project_lead");
    const accepted = { ...cv, reviewState: "accepted" } as const;
    expect(documentCapabilities(pl, target, accessModes.normal, accepted).review).toBe(false);
    expect(documentCapabilities(participant, target, accessModes.normal, cv)).toEqual({
      open: true,
      review: false,
      delete: true,
    });
    expect(documentCapabilities(participant, target, accessModes.normal, accepted).delete).toBe(
      false,
    );
    const byStaff = { ...cv, addedByParticipant: false };
    expect(documentCapabilities(participant, target, accessModes.normal, byStaff).delete).toBe(
      false,
    );
    const rejected = { ...cv, reviewState: "rejected" } as const;
    expect(documentCapabilities(participant, target, accessModes.normal, rejected).delete).toBe(
      true,
    );
  });
});

const parse = (input: object) => DocumentReviewInput.safeParse(input).success;

describe("the documents API schemas (ADR-0010)", () => {
  it("takes base64 content and a file name, strictly", () => {
    const input = { type: "cv", fileName: "Lebenslauf.pdf", content: "JVBERi0=" };
    expect(DocumentUploadInput.safeParse(input).success).toBe(true);
    expect(DocumentUploadInput.safeParse({ ...input, content: "not base64!" }).success).toBe(false);
    expect(DocumentUploadInput.safeParse({ ...input, mimeType: "x" }).success).toBe(false);
  });

  it("needs a reason code for a rejection and none for an acceptance", () => {
    expect(parse({ decision: "accepted" })).toBe(true);
    expect(parse({ decision: "rejected", reasonCode: "unreadable" })).toBe(true);
    expect(parse({ decision: "rejected" })).toBe(false);
    expect(parse({ decision: "accepted", reasonCode: "unreadable" })).toBe(false);
  });

  it("answers same-origin content links and the list", () => {
    const expiresAt = "2026-10-22T10:00:00.000Z";
    expect(
      DocumentOpening.safeParse({ url: "/api/v1/document-content/abc", expiresAt }).success,
    ).toBe(true);
    expect(DocumentOpening.safeParse({ url: "https://x/abc", expiresAt }).success).toBe(false);
    const limits = { maxBytes: 1, maxLiveDocuments: 1, maxUploadsPerHour: 1 };
    expect(DocumentList.safeParse({ documents: [], addableTypes: ["cv"], limits }).success).toBe(
      true,
    );
  });
});
