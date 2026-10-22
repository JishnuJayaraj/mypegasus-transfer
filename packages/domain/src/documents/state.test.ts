import { describe, expect, it } from "vitest";
import { DocumentState } from "../completeness/engine";
import {
  DocumentDeleteReason,
  DocumentReviewReason,
  DocumentReviewState,
  documentState,
} from "./state";

const live = (reviewState: DocumentReviewState) => documentState({ reviewState, deletedAt: null });

describe("documentState (process-and-lifecycle.md, document review)", () => {
  it("maps a live document's review to the completeness engine's states", () => {
    expect(DocumentReviewState.options.map(live)).toEqual(DocumentState.options);
    expect(live("unreviewed")).toBe("uploaded");
  });

  it("counts a deleted document as nothing", () => {
    for (const reviewState of DocumentReviewState.options) {
      expect(documentState({ reviewState, deletedAt: "2026-10-22T08:00:00Z" })).toBeNull();
    }
  });

  it("names the review and deletion reason codes (Q146)", () => {
    expect(DocumentReviewReason.options).toEqual(["unreadable", "wrong_document", "incomplete"]);
    expect(DocumentDeleteReason.options).toEqual([
      "wrong_person",
      "wrong_file",
      "duplicate",
      "participant_request",
    ]);
  });
});
