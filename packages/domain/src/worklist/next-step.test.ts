import { describe, expect, it } from "vitest";
import type { WorklistItem } from "./projection";
import { compareOpenSteps, nextStep, openSteps, urgencyOrder, type OpenStep } from "./next-step";
import { item } from "./testing/item";

// "Nächster Schritt" (process-and-lifecycle.md, the work list's next step): by tier, then by
// date, then by the existing kind order. Synthetic rows only.

const appointment = (
  kind: WorklistItem["appointments"]["items"][number]["kind"],
  startsAt: string,
): WorklistItem["appointments"]["items"][number] => ({
  kind,
  appointmentId: "00000000-0000-4000-8000-0000000000b1",
  appointmentKind: "consultation",
  startsAt,
});

/** One row carrying an item of every tier. */
const everything = item({
  deadlines: [
    { kind: "tg_start", date: "2026-11-20", state: "upcoming" },
    { kind: "privacy_notice", date: "2026-10-01", state: "overdue" },
  ],
  appointments: {
    next: null,
    items: [appointment("missed", "2026-10-20T08:00:00.000Z")],
  },
  caseItems: [{ kind: "evidence_invalidated", date: "2026-10-05" }],
  agenturItems: [{ kind: "tl407_escalated", date: "2026-10-15" }],
  flags: ["dsv_never_offered"],
  actions: [
    { kind: "field", key: "mobile", state: "missing" },
    { kind: "document", key: "cv", state: "missing" },
    { kind: "document", key: "id_card", state: "rejected" },
  ],
});

const describeStep = (step: OpenStep) => `${step.tier}:${step.source}:${step.kind}`;

describe("openSteps", () => {
  it("orders every open item by tier: overdue, undated or escalated, upcoming, participant", () => {
    expect(openSteps(everything).map(describeStep)).toEqual([
      "1:deadline:privacy_notice",
      "1:appointment:missed",
      "2:case:evidence_invalidated",
      "2:agentur:tl407_escalated",
      "2:flag:dsv_never_offered",
      "3:deadline:tg_start",
      "4:action:document",
      "4:action:document",
      "4:action:field",
    ]);
    // Rejected uploads first, then missing documents, then missing fields.
    expect(
      openSteps(everything)
        .filter((step) => step.source === "action")
        .map((step) => step.source === "action" && `${step.action.key}:${step.action.state}`),
    ).toEqual(["id_card:rejected", "cv:missing", "mobile:missing"]);
  });

  it("has nothing for a row without open items", () => {
    expect(openSteps(item())).toEqual([]);
    expect(nextStep(item())).toBeNull();
  });

  it("puts every appointment item to resolve in the overdue tier, by its Berlin date", () => {
    const steps = openSteps(
      item({
        appointments: {
          next: { kind: "info_event", startsAt: "2026-12-01T08:00:00.000Z" },
          items: [
            appointment("needs_resolution", "2026-11-30T08:00:00.000Z"),
            appointment("attendance_conflict", "2026-10-01T08:00:00.000Z"),
            // 23:30 UTC is the next Berlin day.
            appointment("attendance_missing", "2026-10-31T23:30:00.000Z"),
            appointment("notice_undelivered", "2026-11-01T08:00:00.000Z"),
          ],
        },
      }),
    );
    expect(steps.map((step) => [step.tier, step.kind, "date" in step && step.date])).toEqual([
      [1, "attendance_conflict", "2026-10-01"],
      [1, "attendance_missing", "2026-11-01"],
      [1, "notice_undelivered", "2026-11-01"],
      [1, "needs_resolution", "2026-11-30"],
    ]);
  });

  it("within a tier, the older date first, then the kind order", () => {
    const steps = openSteps(
      item({
        deadlines: [
          { kind: "asu_due", date: "2026-10-10", state: "overdue" },
          { kind: "offer_deadline", date: "2026-10-10", state: "overdue" },
          { kind: "tg_start", date: "2026-10-01", state: "overdue" },
          { kind: "privacy_notice", date: "2026-11-10", state: "upcoming" },
          { kind: "latest_entry_cutoff", date: "2026-11-05", state: "upcoming", final: true },
        ],
      }),
    );
    expect(steps.map(describeStep)).toEqual([
      "1:deadline:tg_start",
      "1:deadline:offer_deadline",
      "1:deadline:asu_due",
      "3:deadline:latest_entry_cutoff",
      "3:deadline:privacy_notice",
    ]);
    expect(steps[3]).toMatchObject({ final: true });
  });

  it("orders the undated tier by its dates, the undated items after them, then by kind", () => {
    const steps = openSteps(
      item({
        caseItems: [
          // An orientation, never a date to act by: undated (process-and-lifecycle.md, dates).
          { kind: "knowledge_date_missing", date: "2026-01-01" },
          { kind: "kug200b_withdrawal_ba_notice", date: "2026-10-20" },
          { kind: "kug200b_offer_open", date: "2026-10-20" },
        ],
        agenturItems: [{ kind: "ba_report_pending", date: "2026-10-01" }],
        flags: ["profiling_declined_after_entry", "conflict_dsv_signed_profiling_declined"],
      }),
    );
    expect(steps.map(describeStep)).toEqual([
      "2:agentur:ba_report_pending",
      "2:case:kug200b_offer_open",
      "2:case:kug200b_withdrawal_ba_notice",
      "2:case:knowledge_date_missing",
      "2:flag:conflict_dsv_signed_profiling_declined",
      "2:flag:profiling_declined_after_entry",
    ]);
    expect(steps.find((step) => step.kind === "knowledge_date_missing")).toMatchObject({
      date: "2026-01-01",
    });
  });
});

describe("nextStep", () => {
  it("is the first open item, with how many more there are", () => {
    expect(nextStep(everything)).toEqual({
      step: { tier: 1, source: "deadline", kind: "privacy_notice", date: "2026-10-01" },
      more: 8,
    });
  });

  it("ranks an undated item above any dated one of a lower tier", () => {
    const step = nextStep(
      item({
        caseItems: [{ kind: "evidence_invalidated", date: "2026-11-01" }],
        deadlines: [{ kind: "tg_start", date: "2026-10-23", state: "upcoming" }],
      }),
    );
    expect(step?.step).toMatchObject({ tier: 2, kind: "evidence_invalidated" });
    expect(
      nextStep(
        item({
          flags: ["dsv_never_offered"],
          deadlines: [{ kind: "tg_start", date: "2026-10-23", state: "upcoming" }],
        }),
      )?.step,
    ).toMatchObject({ tier: 2, kind: "dsv_never_offered" });
  });

  it("names a missing field only when nothing else is open", () => {
    expect(
      nextStep(item({ actions: [{ kind: "field", key: "mobile", state: "missing" }] })),
    ).toEqual({
      step: {
        tier: 4,
        source: "action",
        kind: "field",
        action: { kind: "field", key: "mobile", state: "missing" },
      },
      more: 0,
    });
  });
});

describe("compareOpenSteps", () => {
  it("is zero for equal steps and puts no step last", () => {
    const [a] = openSteps(everything);
    expect(compareOpenSteps(a!, a!)).toBe(0);
    expect(compareOpenSteps(null, null)).toBe(0);
    expect(compareOpenSteps(a!, null)).toBeLessThan(0);
    expect(compareOpenSteps(null, a!)).toBeGreaterThan(0);
  });
});

const row = (id: number, overrides: Partial<WorklistItem>) =>
  item({ id: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`, ...overrides });
const order = (rows: WorklistItem[]) => urgencyOrder(rows).map((r) => r.id.slice(-2));

describe("urgencyOrder (the work list's default sort)", () => {
  it("sorts an overdue deadline above an undated case item, that above an upcoming deadline, that above a missing field", () => {
    const rows = [
      row(1, { actions: [{ kind: "field", key: "mobile", state: "missing" }] }),
      row(2, { deadlines: [{ kind: "tg_start", date: "2026-11-01", state: "upcoming" }] }),
      row(3, { caseItems: [{ kind: "evidence_invalidated", date: "2026-10-01" }] }),
      row(4, { deadlines: [{ kind: "asu_due", date: "2026-10-30", state: "overdue" }] }),
      row(5, {}),
    ];
    expect(order(rows)).toEqual(["04", "03", "02", "01", "05"]);
  });

  it("breaks a tie by the most open items, then by last name in German order, then keeps the API order", () => {
    const step = { kind: "tg_start", date: "2026-11-01", state: "upcoming" } as const;
    const field = { kind: "field", key: "mobile", state: "missing" } as const;
    const rows = [
      row(1, { deadlines: [step], lastName: "Zander" }),
      row(2, { deadlines: [step], lastName: "Özdemir" }),
      row(3, { deadlines: [step], lastName: "Ober", actions: [field] }),
      row(4, { deadlines: [step], lastName: undefined }),
      row(5, { deadlines: [step], lastName: "ozdemir" }),
      row(6, { deadlines: [step], lastName: undefined }),
    ];
    expect(order(rows)).toEqual(["03", "02", "05", "01", "04", "06"]);
  });
});
