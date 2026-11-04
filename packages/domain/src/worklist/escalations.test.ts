import { describe, expect, it } from "vitest";
import { project, snapshot, state } from "../lifecycle/testing/planner";
import { escalationRows, Escalations, participationEscalations } from "./escalations";

// Synthetic values. The wave's TG start is 2027-04-01; entry on 2027-04-01.
const approved = { validOn: "2027-03-01", recordedAt: new Date("2027-03-01T09:00:00Z") };
const entered = (profilingStatus: "profiling_declined" | "profiling_in_progress") =>
  snapshot({
    current: state("active_in_tg", profilingStatus, "dsv_signed"),
    participation: { tgStart: null, offerDeadline: null, tgEntryDate: "2027-04-01" },
    facts: { profilingExceptionApproved: approved },
  });

describe("participationEscalations (Q57, Q189)", () => {
  it("escalates an unsubmitted TL 407 from TG start + 14", () => {
    expect(participationEscalations(snapshot(), project, [], null, "2027-04-14")).toEqual([]);
    expect(participationEscalations(snapshot(), project, [], null, "2027-04-15")).toEqual([
      { type: "tl407_not_submitted", since: "2027-04-15" },
    ]);
  });

  it("escalates a refusal after entry the same day, never before the entry", () => {
    const declined = entered("profiling_declined");
    expect(participationEscalations(declined, project, [], "2027-04-10", "2027-04-10")).toEqual([
      { type: "profiling_compliance", since: "2027-04-10" },
    ]);
    expect(participationEscalations(declined, project, [], "2027-03-20", "2027-04-10")).toEqual([
      { type: "profiling_compliance", since: "2027-04-01" },
    ]);
    expect(participationEscalations(declined, project, [], null, "2027-04-10")).toEqual([
      { type: "profiling_compliance", since: "2027-04-01" },
    ]);
  });

  it("escalates a missed exception deadline the day it is missed, with no grace period", () => {
    // The TL 407 of an earlier attempt stands, so only the compliance escalates.
    const open = entered("profiling_in_progress");
    const sent = [
      {
        submittedOn: "2027-03-30",
        channel: "email" as const,
        originalRequired: false,
        originalSentOn: null,
        rejectedOn: null,
      },
    ];
    expect(participationEscalations(open, project, sent, null, "2027-05-01")).toEqual([]);
    expect(participationEscalations(open, project, sent, null, "2027-05-02")).toEqual([
      { type: "profiling_compliance", since: "2027-05-02" },
    ]);
  });
});

describe("escalationRows: counts only (data-protection.md, the regional view)", () => {
  it("counts distinct participations per type, the oldest's days overdue, sorted by project", () => {
    const rows = escalationRows(
      [
        {
          projectId: "00000000-0000-4000-8000-000000000002",
          projectName: "Werk Süd",
          leads: ["Zora Leitung", "Anna Leitung"],
          participations: [
            [
              { type: "tl407_not_submitted", since: "2027-04-15" },
              { type: "profiling_compliance", since: "2027-04-20" },
              { type: "profiling_compliance", since: "2027-04-10" },
            ],
            [{ type: "tl407_not_submitted", since: "2027-04-01" }],
          ],
        },
        {
          projectId: "00000000-0000-4000-8000-000000000001",
          projectName: "Werk Nord",
          leads: [],
          participations: [[], []],
        },
        {
          projectId: "00000000-0000-4000-8000-000000000003",
          projectName: "Werk Ost",
          leads: ["Bea Leitung"],
          participations: [[{ type: "profiling_compliance", since: "2027-04-21" }]],
        },
      ],
      "2027-04-21",
    );
    expect(rows).toEqual([
      {
        projectId: "00000000-0000-4000-8000-000000000003",
        projectName: "Werk Ost",
        leads: ["Bea Leitung"],
        counts: [{ type: "profiling_compliance", count: 1, oldestDaysOverdue: 0 }],
      },
      {
        projectId: "00000000-0000-4000-8000-000000000002",
        projectName: "Werk Süd",
        leads: ["Anna Leitung", "Zora Leitung"],
        counts: [
          { type: "tl407_not_submitted", count: 2, oldestDaysOverdue: 20 },
          { type: "profiling_compliance", count: 1, oldestDaysOverdue: 11 },
        ],
      },
    ]);
    // The response's schema has no place for a participant.
    expect(
      Escalations.safeParse({
        generatedAt: "2027-04-21T08:00:00.000Z",
        rows: [{ ...rows[0], participationIds: [] }],
      }).success,
    ).toBe(false);
  });

  it("orders projects of the same name by id", () => {
    const one = (id: string) => ({
      projectId: id,
      projectName: "Werk",
      leads: [],
      participations: [[{ type: "tl407_not_submitted" as const, since: "2027-04-21" }]],
    });
    const b = "00000000-0000-4000-8000-00000000000b";
    const a = "00000000-0000-4000-8000-00000000000a";
    expect(escalationRows([one(b), one(a)], "2027-04-21").map((r) => r.projectId)).toEqual([a, b]);
  });
});
