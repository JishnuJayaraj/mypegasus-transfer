import { describe, expect, it } from "vitest";
import {
  canonicalEvidence,
  ExceptionEvidenceInput,
  maySeeReview,
  normaliseBaConfirmation,
  normaliseBaReference,
  seesReviews,
} from "./exception-evidence";

const participationId = "00000000-0000-4000-a000-000000000001";
const digest = (c: string) => c.repeat(64);

describe("normaliseBaReference", () => {
  it.each([
    ["  Frau  Müller  ", "frau müller"],
    ["AZ-4711/2026", "az-4711/2026"],
    ["Herr Öztürk ẞ", "herr öztürk ß"],
    // Decomposed input is composed, so both spellings are the same reference.
    ["Müller", "müller"],
  ])("normalises %j to %j", (input, expected) => {
    expect(normaliseBaReference(input)).toBe(expected);
  });

  it.each([["   "], ["a\nb"], ["a\tb"], ["x".repeat(101)]])("refuses %j", (input) => {
    expect(normaliseBaReference(input)).toBeNull();
  });
});

describe("normaliseBaConfirmation", () => {
  const input = {
    agenturKey: "beispielstadt-nord",
    reference: " AZ 1 ",
    confirmedOn: "2091-01-20",
  };

  it("normalises the reference and keeps the code and date", () => {
    expect(normaliseBaConfirmation(input, "2091-01-20")).toEqual({
      ok: true,
      value: { agenturKey: "beispielstadt-nord", reference: "az 1", confirmedOn: "2091-01-20" },
    });
  });

  it("refuses a date after today and an empty reference", () => {
    expect(normaliseBaConfirmation(input, "2091-01-19")).toEqual({
      ok: false,
      code: "confirmation_in_future",
    });
    expect(normaliseBaConfirmation({ ...input, reference: " " }, "2091-01-20")).toEqual({
      ok: false,
      code: "reference_invalid",
    });
  });
});

describe("canonicalEvidence (round 17)", () => {
  it("sorts and de-duplicates the content digests", () => {
    const payload = canonicalEvidence(participationId, {
      kind: "documents",
      contentDigests: [digest("b"), digest("a"), digest("b")],
    });
    expect(payload).toBe(
      [
        "profiling-exception-evidence:v1",
        participationId,
        "documents",
        digest("a"),
        digest("b"),
      ].join("\n"),
    );
    expect(
      canonicalEvidence(participationId, {
        kind: "documents",
        contentDigests: [digest("a"), digest("b")],
      }),
    ).toBe(payload);
  });

  it("lists the confirmation's facts in key order", () => {
    expect(
      canonicalEvidence(participationId, {
        kind: "ba_confirmation",
        confirmation: { reference: "az 1", confirmedOn: "2091-01-20", agenturKey: "nord" },
      }),
    ).toBe(
      [
        "profiling-exception-evidence:v1",
        participationId,
        "ba_confirmation",
        "agenturKey=nord",
        "confirmedOn=2091-01-20",
        "reference=az 1",
      ].join("\n"),
    );
  });

  it("binds the payload to the participation", () => {
    const source = { kind: "documents", contentDigests: [digest("a")] } as const;
    expect(canonicalEvidence(participationId, source)).not.toBe(
      canonicalEvidence("00000000-0000-4000-a000-000000000002", source),
    );
  });
});

describe("ExceptionEvidenceInput", () => {
  it("takes documents or a BA confirmation, nothing else", () => {
    expect(ExceptionEvidenceInput.safeParse({ kind: "documents", documentIds: [] }).success).toBe(
      false,
    );
    expect(
      ExceptionEvidenceInput.safeParse({
        kind: "ba_confirmation",
        agenturKey: "nord",
        reference: "x",
        confirmedOn: "2091-02-30",
      }).success,
    ).toBe(false);
    expect(
      ExceptionEvidenceInput.safeParse({
        kind: "documents",
        documentIds: [participationId],
        agenturKey: "nord",
      }).success,
    ).toBe(false);
  });
});

const manager = (regionIds: "all" | ReadonlySet<string>) =>
  ({
    kind: "staff",
    staffUserId: "rom-1",
    orgRoles: new Map([["regional_operations_manager" as const, { regionIds }]]),
    projectRoles: {},
    assignedParticipationIds: new Set<string>(),
  }) as const;

describe("the queue Freigaben (Q80)", () => {
  const regionalAdmin = {
    ...manager("all"),
    orgRoles: new Map([["regional_admin" as const, { regionIds: "all" as const }]]),
  };

  it("is the regional operations manager's, for the projects of their regions", () => {
    const north = manager(new Set(["north"]));
    expect(seesReviews(north)).toBe(true);
    expect(seesReviews(regionalAdmin)).toBe(false);
    expect(seesReviews({ kind: "participant", participationId: "p" } as never)).toBe(false);
    expect(maySeeReview(north, { regionId: "north" })).toBe(true);
    expect(maySeeReview(north, { regionId: "south" })).toBe(false);
    expect(maySeeReview(north, { regionId: null })).toBe(false);
    expect(maySeeReview(manager("all"), { regionId: null })).toBe(true);
    expect(maySeeReview(regionalAdmin, { regionId: "north" })).toBe(false);
    expect(maySeeReview({ kind: "participant" } as never, { regionId: "north" })).toBe(false);
  });
});
