import { describe, expect, it } from "vitest";
import {
  batchEligibility,
  batchRecheck,
  batchSettings,
  confirmationProblem,
  submissionProblem,
  type BatchMemberFacts,
} from "./batches";

// Kug 200b batches (process-and-lifecycle.md, Kug 200b batches; Q91, Q187, Q203). Synthetic.

const facts = (overrides: Partial<BatchMemberFacts> = {}): BatchMemberFacts => ({
  scanUsable: true,
  closed: false,
  placementAgenturKey: "beispielstadt-nord",
  asuChannel: "kug_200b",
  asuRegistered: false,
  formVersion: "09-2021",
  inOpenBatch: false,
  submitted: false,
  ...overrides,
});
const scope = { agenturKey: "beispielstadt-nord", outdatedVersions: [] as string[] };

describe("batchEligibility", () => {
  it("takes a usable scan of an open participation of the Agentur", () => {
    expect(batchEligibility(facts(), scope)).toBeNull();
    expect(batchEligibility(facts({ asuChannel: "online_self", asuRegistered: true }), scope)).toBe(
      null,
    );
  });

  it("names the first problem in a fixed order", () => {
    expect(batchEligibility(facts({ scanUsable: false, closed: true }), scope)).toBe(
      "scan_unusable",
    );
    expect(batchEligibility(facts({ closed: true }), scope)).toBe("participation_closed");
    expect(batchEligibility(facts({ placementAgenturKey: "beispielstadt-sued" }), scope)).toBe(
      "placement_agentur_changed",
    );
    expect(batchEligibility(facts({ placementAgenturKey: null }), scope)).toBe(
      "placement_agentur_changed",
    );
    expect(batchEligibility(facts({ inOpenBatch: true }), scope)).toBe("in_open_batch");
    expect(batchEligibility(facts({ submitted: true }), scope)).toBe("already_submitted");
    expect(batchEligibility(facts({ asuChannel: null }), scope)).toBe("asu_route_unset");
    expect(batchEligibility(facts({ asuRegistered: true }), scope)).toBe("asu_registered");
  });

  it("refuses an expired version only where the Agentur rejects outdated forms", () => {
    const strict = { ...scope, outdatedVersions: ["09-2021"] };
    expect(batchEligibility(facts(), strict)).toBe("form_version_outdated");
    expect(batchEligibility(facts({ formVersion: "07-2025" }), strict)).toBeNull();
    expect(batchEligibility(facts({ formVersion: null }), strict)).toBe("scan_unusable");
  });
});

describe("batchRecheck", () => {
  const batch = {
    agenturKey: "beispielstadt-nord",
    channel: "scan_email" as const,
    artifact: "kug200a" as const,
    members: [
      { participationId: "p1", documentId: "d1", asuChannel: "kug_200b" as const },
      { participationId: "p2", documentId: "d2", asuChannel: null },
    ],
  };
  const current = { channel: "scan_email" as const, artifact: "kug200a" as const };
  const now = (overrides: Record<string, Partial<BatchMemberFacts>> = {}) =>
    new Map(
      batch.members.map((m) => [
        m.participationId,
        facts({ asuChannel: m.asuChannel, inOpenBatch: true, ...overrides[m.participationId] }),
      ]),
    );

  it("is clean while nothing moved, its own membership included", () => {
    expect(batchRecheck(batch, now(), current, [])).toEqual([]);
  });

  it("gives a row per member that moved, by its first problem", () => {
    const moved = now({
      p1: { closed: true },
      p2: { asuChannel: "online_self" },
    });
    expect(batchRecheck(batch, moved, current, [])).toEqual([
      { participationId: "p1", documentId: "d1", reason: "participation_closed" },
      { participationId: "p2", documentId: "d2", reason: "asu_route_changed" },
    ]);
    expect(
      batchRecheck(batch, now({ p1: { placementAgenturKey: "beispielstadt-sued" } }), current, []),
    ).toEqual([{ participationId: "p1", documentId: "d1", reason: "placement_agentur_changed" }]);
    expect(batchRecheck(batch, now({ p2: { scanUsable: false } }), current, [])).toEqual([
      { participationId: "p2", documentId: "d2", reason: "scan_unusable" },
    ]);
    expect(batchRecheck(batch, now({ p1: { asuRegistered: true } }), current, [])).toEqual([
      { participationId: "p1", documentId: "d1", reason: "asu_registered" },
    ]);
    expect(batchRecheck(batch, now(), current, ["09-2021"])).toHaveLength(2);
  });

  it("refuses a member that has no facts any more", () => {
    const missing = now();
    missing.delete("p2");
    expect(batchRecheck(batch, missing, current, [])).toEqual([
      { participationId: "p2", documentId: "d2", reason: "scan_unusable" },
    ]);
  });

  it("gives one batch-level row when the channel or the artifact resolves otherwise", () => {
    const row = { participationId: null, documentId: null, reason: "settings_changed" };
    expect(batchRecheck(batch, now(), { ...current, channel: "upload" }, [])).toEqual([row]);
    expect(
      batchRecheck(batch, now(), { ...current, artifact: "accepted_alternative" }, []),
    ).toEqual([row]);
    expect(batchRecheck(batch, now(), { ...current, channel: null }, [])).toEqual([row]);
  });
});

describe("batchSettings", () => {
  const confirmation = {
    source: "email_agentur" as const,
    confirmedBy: "00000000-0000-4000-8000-000000000001",
    confirmedOn: "2026-10-20",
  };

  it("needs the batch channel; the Kug 200a is the artifact by default", () => {
    expect(batchSettings({}, undefined)).toEqual({
      channel: null,
      artifact: { kind: "kug200a" },
    });
    expect(
      batchSettings({ asu_registration: { batchSubmissionChannel: "upload" } }, undefined),
    ).toEqual({ channel: "upload", artifact: { kind: "kug200a" } });
  });

  it("takes the alternative only from an Agentur-scoped setting with its confirmation", () => {
    const settings = {
      asu_registration: { batchSubmissionChannel: "upload", kug200aAlternativeAccepted: true },
    } as const;
    expect(
      batchSettings(settings, { layer: "override:agentur:beispielstadt-nord", ...confirmation }),
    ).toEqual({
      channel: "upload",
      artifact: { kind: "accepted_alternative", ...confirmation },
    });
    expect(batchSettings(settings, { layer: "template:beispielstadt-nord@3" }).artifact).toEqual({
      kind: "kug200a",
    });
    expect(batchSettings(settings, undefined).artifact).toEqual({ kind: "kug200a" });
  });
});

describe("submissionProblem", () => {
  it("takes a sent date from the batch's day to today", () => {
    const at = { createdOn: "2026-11-20", today: "2026-11-24" };
    expect(submissionProblem("2026-11-24", at)).toBeNull();
    expect(submissionProblem("2026-11-20", at)).toBeNull();
    expect(submissionProblem("2026-11-25", at)).toBe("submitted_on_in_future");
    expect(submissionProblem("2026-11-19", at)).toBe("submitted_before_batch");
  });
});

describe("confirmationProblem", () => {
  it("takes the Agentur's date from the submission to today", () => {
    const at = { registeredOn: "2026-11-24", today: "2026-12-01" };
    expect(confirmationProblem("2026-11-24", at)).toBeNull();
    expect(confirmationProblem("2026-12-01", at)).toBeNull();
    expect(confirmationProblem("2026-12-02", at)).toBe("confirmed_on_in_future");
    expect(confirmationProblem("2026-11-23", at)).toBe("confirmed_before_submission");
  });
});
