import { describe, expect, it } from "vitest";
import { reminderConsentVersion } from "../notices/catalog";
import {
  chooseChannel,
  consentUpgradeOffered,
  nextEligibleDate,
  portalReach,
  ReminderCancelReason,
  reminderEligibility,
  reminderPolicy,
  ReminderSkip,
  ReminderStatus,
  type ReminderChannelFacts,
} from "./model";
import { ReminderRequestInput } from "./api";

// Synthetic ids and dates only.
const channel = (overrides: Partial<ReminderChannelFacts> = {}): ReminderChannelFacts => ({
  id: "00000000-0000-4000-8000-0000000000c5",
  kind: "email",
  verifiedAt: "2026-10-01T09:00:00.000Z",
  live: true,
  consentVersion: "portal-contact-consent:v2",
  consentEnded: false,
  ...overrides,
});

describe("the reminder codes (data-protection.md, reminders)", () => {
  it("are closed lists", () => {
    expect(ReminderStatus.options).toEqual([
      "queued",
      "dispatching",
      "sent",
      "failed",
      "delivery_unknown",
      "cancelled",
    ]);
    expect(ReminderSkip.options).toEqual([
      "no_channel",
      "consent_required",
      "reminded_recently",
      "nothing_open",
      "participation_closed",
    ]);
    expect(ReminderCancelReason.options).toEqual([
      "channel_unavailable",
      "consent_ended",
      "participation_closed",
      "nothing_open",
      "requester_no_longer_authorized",
      "delivery_unavailable",
    ]);
  });
});

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const input = (ids: string[]) =>
  ReminderRequestInput.safeParse({ kind: "open_items", participationIds: ids }).success;

describe("reminderPolicy (Q155)", () => {
  it("allows the next reminder of a Monday's on the Thursday", () => {
    expect(reminderPolicy.windowDays).toBe(3);
    expect(nextEligibleDate("2026-10-19")).toBe("2026-10-22");
  });

  it("counts Berlin calendar days across a DST change", () => {
    // Summer time ends on Sunday, 2026-10-25; spring forward on Sunday, 2027-03-28.
    expect(nextEligibleDate("2026-10-23")).toBe("2026-10-26");
    expect(nextEligibleDate("2027-03-27")).toBe("2027-03-30");
  });

  it("takes 1 to 500 distinct participations per request", () => {
    expect(input([])).toBe(false);
    expect(input([id(1)])).toBe(true);
    expect(input(Array.from({ length: 500 }, (_, n) => id(n)))).toBe(true);
    expect(input(Array.from({ length: 501 }, (_, n) => id(n)))).toBe(false);
    expect(input([id(1), id(1)])).toBe(false);
  });
});

describe("chooseChannel (Q154)", () => {
  it("takes the most recently verified of two emails", () => {
    const older = channel({ id: "00000000-0000-4000-8000-0000000000c1" });
    const newer = channel({
      id: "00000000-0000-4000-8000-0000000000c2",
      verifiedAt: "2026-10-02T09:00:00.000Z",
    });
    expect(chooseChannel([older, newer])).toBe(newer);
  });

  it("prefers an email to a more recently verified mobile", () => {
    const email = channel();
    const mobile = channel({ id: "00000000-0000-4000-8000-0000000000c9", kind: "sms" });
    expect(chooseChannel([{ ...mobile, verifiedAt: "2026-10-09T09:00:00.000Z" }, email])).toBe(
      email,
    );
    expect(chooseChannel([mobile, { ...email, consentVersion: "portal-contact-consent:v1" }])).toBe(
      mobile,
    );
  });

  it("breaks a tie by the smaller id", () => {
    const a = channel({ id: "00000000-0000-4000-8000-0000000000a1" });
    const b = channel({ id: "00000000-0000-4000-8000-0000000000b1" });
    expect(chooseChannel([b, a])).toBe(a);
    expect(chooseChannel([a, b])).toBe(a);
    expect(chooseChannel([a, { ...a }])).toEqual(a);
  });

  it("takes only a live channel with a live consent v2", () => {
    expect(reminderConsentVersion).toBe("portal-contact-consent:v2");
    expect(
      chooseChannel([
        channel({ live: false }),
        channel({ consentEnded: true }),
        channel({ consentVersion: "portal-contact-consent:v1" }),
      ]),
    ).toBeNull();
  });
});

describe("portalReach", () => {
  it("is reachable through a live channel with a live consent v2", () => {
    expect(portalReach([channel({ live: false }), channel()])).toBe("reachable");
  });

  it("needs a consent with a live channel of an older version or an ended consent", () => {
    expect(portalReach([channel({ consentVersion: "portal-contact-consent:v1" })])).toBe(
      "consent_required",
    );
    expect(portalReach([channel({ consentEnded: true })])).toBe("consent_required");
  });

  it("isn't reachable without a live channel", () => {
    expect(portalReach([])).toBe("not_reachable");
    expect(portalReach([channel({ live: false })])).toBe("not_reachable");
  });
});

describe("reminderEligibility", () => {
  const open = { status: "informed", actionCount: 2, portal: "reachable" } as const;
  const today = "2026-10-22";

  it("allows an open, reachable participation not reminded within the window", () => {
    expect(reminderEligibility(open, null, today)).toBe("ok");
    expect(reminderEligibility(open, "2026-10-19", today)).toBe("ok");
  });

  it("gives each skip code", () => {
    expect(reminderEligibility({ ...open, status: "exited" }, null, today)).toBe(
      "participation_closed",
    );
    expect(reminderEligibility({ ...open, actionCount: 0 }, null, today)).toBe("nothing_open");
    expect(reminderEligibility({ ...open, portal: "not_reachable" }, null, today)).toBe(
      "no_channel",
    );
    expect(reminderEligibility({ ...open, portal: "consent_required" }, null, today)).toBe(
      "consent_required",
    );
    expect(reminderEligibility(open, "2026-10-20", today)).toBe("reminded_recently");
    expect(reminderEligibility(open, today, today)).toBe("reminded_recently");
  });
});

describe("consentUpgradeOffered (data-protection.md, consent v2)", () => {
  it("is offered for a live channel with an earlier consent only", () => {
    expect(consentUpgradeOffered({ live: true, consentVersion: "portal-contact-consent:v1" })).toBe(
      true,
    );
    expect(consentUpgradeOffered({ live: true, consentVersion: "portal-contact-consent:v2" })).toBe(
      false,
    );
    expect(
      consentUpgradeOffered({ live: false, consentVersion: "portal-contact-consent:v1" }),
    ).toBe(false);
  });
});
