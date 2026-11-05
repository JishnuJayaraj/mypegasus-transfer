import { describe, expect, it } from "vitest";
import { wave } from "../lifecycle/testing/context";
import { snapshot, state } from "../lifecycle/testing/planner";
import {
  agenturItems,
  kug200bConfirmationFollowUpDays,
  liveAttempt,
  originalOutstanding,
  originalSentProblem,
  rejectionProblem,
  retainableOriginal,
  tl407EscalationDate,
  tl407EscalationDaysAfterTgStart,
  tl407SubmissionDeadline,
  tl407SubmissionProblem,
  tl407SubmissionSettings,
  type Tl407Attempt,
  type Tl407SubmissionFacts,
  type Tl407WorkFacts,
} from "./submissions";

// Synthetic dates. The wave's TG start is 2027-04-01.
const settings = {
  channel: "email" as const,
  originalRequired: true,
  leadTimeDays: 10,
  rejectsOutdatedFormVersions: false,
};
const attempt = (overrides: Partial<Tl407Attempt> = {}): Tl407Attempt => ({
  submittedOn: "2027-03-10",
  channel: "email",
  originalRequired: true,
  originalSentOn: null,
  rejectedOn: null,
  ...overrides,
});
const rejected = attempt({ rejectedOn: "2027-03-15" });
const ready: Tl407SubmissionFacts = {
  status: "informed",
  placementAgenturKey: "beispielstadt-nord",
  settings,
  scan: { formVersion: "08-2025", signedOn: "2027-03-05" },
  versionExpired: false,
  attempts: [],
};
const today = "2027-03-20";
const work = (overrides: Partial<Tl407WorkFacts> = {}): Tl407WorkFacts => ({
  attempts: [],
  leadTimeDays: 10,
  kug200bRegistration: null,
  baReportPendingSince: null,
  ...overrides,
});
const approved = { validOn: "2027-03-01", recordedAt: new Date("2027-03-01T09:00:00Z") };

describe("tl407SubmissionSettings (regional-variation.md, blockers; Q92)", () => {
  it("needs all four settings", () => {
    const all = {
      submissionChannel: "upload" as const,
      originalRequired: false,
      leadTimeDays: 0,
      rejectsOutdatedFormVersions: true,
    };
    expect(tl407SubmissionSettings({ agentur_submission: all })).toEqual({
      channel: "upload",
      originalRequired: false,
      leadTimeDays: 0,
      rejectsOutdatedFormVersions: true,
    });
    for (const key of Object.keys(all) as (keyof typeof all)[]) {
      const { [key]: _, ...three } = all;
      expect(tl407SubmissionSettings({ agentur_submission: three })).toBeNull();
    }
    expect(tl407SubmissionSettings({})).toBeNull();
  });
});

describe("tl407SubmissionProblem (process-and-lifecycle.md, TL 407 submission; D26)", () => {
  it("allows a usable scan with all settings, the date from the signature to today", () => {
    expect(tl407SubmissionProblem(ready, null, today)).toBeNull();
    expect(tl407SubmissionProblem(ready, "2027-03-05", today)).toBeNull();
    expect(tl407SubmissionProblem(ready, today, today)).toBeNull();
  });

  it("refuses in the database function's order", () => {
    const cases: [Partial<Tl407SubmissionFacts>, string][] = [
      [{ status: "withdrawn", placementAgenturKey: null }, "participation_closed"],
      [{ placementAgenturKey: null, settings: null }, "placement_agentur_missing"],
      [{ settings: null, scan: null }, "submission_settings_missing"],
      [{ scan: null, attempts: [attempt()] }, "scan_unusable"],
      [{ attempts: [attempt()] }, "already_submitted"],
    ];
    for (const [overrides, problem] of cases) {
      expect(tl407SubmissionProblem({ ...ready, ...overrides }, null, today)).toBe(problem);
    }
  });

  it("refuses an expired version only where the Agentur rejects outdated forms (Q188)", () => {
    const expired = { ...ready, versionExpired: true };
    expect(tl407SubmissionProblem(expired, null, today)).toBeNull();
    const rejects = { ...expired, settings: { ...settings, rejectsOutdatedFormVersions: true } };
    expect(tl407SubmissionProblem(rejects, null, today)).toBe("form_version_outdated");
  });

  it("checks the date: not in the future, not before the signature or the last rejection", () => {
    expect(tl407SubmissionProblem(ready, "2027-03-21", today)).toBe("submitted_on_in_future");
    expect(tl407SubmissionProblem(ready, "2027-03-04", today)).toBe("submitted_before_signature");
    const again = { ...ready, attempts: [rejected] };
    expect(tl407SubmissionProblem(again, null, today)).toBeNull();
    expect(tl407SubmissionProblem(again, "2027-03-14", today)).toBe("submitted_before_rejection");
    expect(tl407SubmissionProblem(again, "2027-03-15", today)).toBeNull();
  });
});

describe("the original and the rejection (Q189)", () => {
  it("records the original once, where the Agentur needs it apart from the submission", () => {
    expect(originalSentProblem(attempt(), "2027-03-10", today)).toBeNull();
    expect(originalSentProblem(attempt({ originalRequired: false }), today, today)).toBe(
      "original_not_required",
    );
    expect(originalSentProblem(attempt({ channel: "paper_original" }), today, today)).toBe(
      "original_not_required",
    );
    expect(originalSentProblem(attempt({ originalSentOn: "2027-03-11" }), today, today)).toBe(
      "original_recorded",
    );
    expect(originalSentProblem(attempt(), "2027-03-21", today)).toBe("date_in_future");
    expect(originalSentProblem(attempt(), "2027-03-09", today)).toBe("date_before_submission");
  });

  it("records a rejection once per attempt, from the submission to today", () => {
    expect(rejectionProblem(attempt(), "2027-03-10", today)).toBeNull();
    expect(rejectionProblem(rejected, today, today)).toBe("already_rejected");
    expect(rejectionProblem(attempt(), "2027-03-21", today)).toBe("date_in_future");
    expect(rejectionProblem(attempt(), "2027-03-09", today)).toBe("date_before_submission");
  });

  it("an attempt stands until rejected; the original is outstanding apart from paper_original", () => {
    expect(liveAttempt([rejected])).toBeNull();
    expect(liveAttempt([attempt(), rejected])).toEqual(attempt());
    expect(originalOutstanding(attempt())).toBe(true);
    expect(originalOutstanding(attempt({ channel: "paper_original" }))).toBe(false);
    expect(originalOutstanding(attempt({ originalSentOn: "2027-03-11" }))).toBe(false);
  });
});

describe("tl407SubmissionDeadline (D27)", () => {
  const informed = snapshot();
  it("is the TG start minus the lead time, or the TG start while unresolved", () => {
    expect(tl407SubmissionDeadline(informed, "ta_tg", work(), today)).toBe("2027-03-22");
    expect(tl407SubmissionDeadline(informed, "ta_tg", work({ leadTimeDays: null }), today)).toBe(
      "2027-04-01",
    );
    const active = snapshot({ current: state("active_in_tg", "profiling_done") });
    expect(tl407SubmissionDeadline(active, "ta_tg", work({ leadTimeDays: 0 }), today)).toBe(
      "2027-04-01",
    );
  });

  it("applies only in ta_tg, informed or active, without a standing submission or a TG start", () => {
    expect(tl407SubmissionDeadline(informed, "ta_only", work(), today)).toBeNull();
    expect(
      tl407SubmissionDeadline(snapshot({ current: state("contacted") }), "ta_tg", work(), today),
    ).toBeNull();
    expect(
      tl407SubmissionDeadline(informed, "ta_tg", work({ attempts: [attempt()] }), today),
    ).toBeNull();
    // A rejection reopens it.
    expect(tl407SubmissionDeadline(informed, "ta_tg", work({ attempts: [rejected] }), today)).toBe(
      "2027-03-22",
    );
    const noStart = snapshot({ wave: { ...wave, defaultTgStart: null } });
    expect(tl407SubmissionDeadline(noStart, "ta_tg", work(), today)).toBeNull();
  });

  it("under an approved exception is the day profiling was done, none before", () => {
    const exception = snapshot({
      current: state("active_in_tg", "profiling_in_progress"),
      facts: { profilingExceptionApproved: approved },
    });
    expect(tl407SubmissionDeadline(exception, "ta_tg", work(), today)).toBeNull();
    const done = {
      ...exception,
      facts: { ...exception.facts, profilingDone: { ...approved, validOn: "2027-04-20" } },
    };
    expect(tl407SubmissionDeadline(done, "ta_tg", work(), today)).toBe("2027-04-20");
  });
});

describe("tl407EscalationDate (Q54, Q189)", () => {
  const informed = snapshot();
  it("escalates from TG start + 14 while unsubmitted, whatever the exception", () => {
    expect(tl407EscalationDaysAfterTgStart).toBe(14);
    expect(tl407EscalationDate(informed, "ta_tg", [], "2027-04-14")).toBeNull();
    expect(tl407EscalationDate(informed, "ta_tg", [], "2027-04-15")).toBe("2027-04-15");
    const exception = snapshot({
      current: state("active_in_tg", "profiling_done"),
      facts: { profilingExceptionApproved: approved, profilingDone: approved },
    });
    expect(tl407EscalationDate(exception, "ta_tg", [], "2027-05-20")).toBe("2027-04-15");
    expect(tl407EscalationDate(informed, "ta_tg", [rejected], "2027-05-20")).toBe("2027-04-15");
  });

  it("dates the current episode: a rejection after the trigger starts a new one that day (Q206 (8))", () => {
    const late = attempt({ submittedOn: "2027-04-01", rejectedOn: "2027-05-20" });
    expect(tl407EscalationDate(informed, "ta_tg", [late], "2027-05-20")).toBe("2027-05-20");
    expect(tl407EscalationDate(informed, "ta_tg", [late], "2027-05-25")).toBe("2027-05-20");
    // While it stood, nothing was escalated.
    expect(
      tl407EscalationDate(informed, "ta_tg", [{ ...late, rejectedOn: null }], "2027-05-20"),
    ).toBeNull();
    // A rejection before the trigger still escalates from TG start + 14.
    expect(tl407EscalationDate(informed, "ta_tg", [late, rejected], "2027-04-14")).toBeNull();
  });

  it("none in ta_only, after a submission, when closed or without a TG start", () => {
    const later = "2027-06-01";
    expect(tl407EscalationDate(informed, "ta_only", [], later)).toBeNull();
    expect(tl407EscalationDate(informed, "ta_tg", [attempt()], later)).toBeNull();
    expect(
      tl407EscalationDate(snapshot({ current: state("withdrawn") }), "ta_tg", [], later),
    ).toBeNull();
    const noStart = snapshot({ wave: { ...wave, defaultTgStart: null } });
    expect(tl407EscalationDate(noStart, "ta_tg", [], later)).toBeNull();
  });
});

describe("agenturItems (process-and-lifecycle.md, TL 407 submission)", () => {
  const informed = snapshot();
  it("lists the escalation, the resubmission, the original and the Kug 200b confirmation", () => {
    expect(
      agenturItems(
        informed,
        "ta_tg",
        work({
          attempts: [rejected],
          kug200bRegistration: { registeredOn: "2027-03-01", confirmedOn: null },
        }),
        "2027-04-15",
      ),
    ).toEqual([
      { kind: "tl407_escalated", date: "2027-04-15" },
      { kind: "tl407_resubmission_open", date: "2027-03-15" },
      { kind: "kug200b_confirmation_missing", date: "2027-03-01" },
    ]);
    expect(
      agenturItems(informed, "ta_tg", work({ attempts: [attempt(), rejected] }), today),
    ).toEqual([{ kind: "tl407_original_missing", date: "2027-03-10" }]);
  });

  it("asks for the confirmation from the follow-up day, until it is recorded", () => {
    expect(kug200bConfirmationFollowUpDays).toBe(14);
    const of = (registeredOn: string, confirmedOn: string | null, type = "ta_tg" as const) =>
      agenturItems(
        snapshot({ current: state("withdrawn") }),
        type,
        work({ kug200bRegistration: { registeredOn, confirmedOn } }),
        today,
      );
    expect(of("2027-03-07", null)).toEqual([]);
    expect(of("2027-03-06", null)).toEqual([
      { kind: "kug200b_confirmation_missing", date: "2027-03-06" },
    ]);
    expect(of("2027-03-06", "2027-03-19")).toEqual([]);
    expect(agenturItems(informed, "ta_only", work(), today)).toEqual([]);
  });

  it("a closed participation keeps the original, never the submission work", () => {
    const closed = snapshot({ current: state("withdrawn") });
    expect(agenturItems(closed, "ta_tg", work({ attempts: [rejected] }), "2027-06-01")).toEqual([]);
    expect(agenturItems(closed, "ta_tg", work({ attempts: [attempt()] }), "2027-06-01")).toEqual([
      { kind: "tl407_original_missing", date: "2027-03-10" },
    ]);
  });

  it("lists a pending BA report last, from its day, in every project type and status (D28)", () => {
    const pending = work({ baReportPendingSince: "2027-02-01" });
    const item = { kind: "ba_report_pending", date: "2027-02-01" };
    // An early exit's task is created at the exit: a closed participation keeps it.
    for (const s of [informed, snapshot({ current: state("exited") })]) {
      expect(agenturItems(s, "ta_tg", pending, today)).toEqual([item]);
      expect(agenturItems(s, "ta_only", pending, today)).toEqual([item]);
    }
    expect(
      agenturItems(informed, "ta_tg", work({ ...pending, attempts: [attempt(), rejected] }), today),
    ).toEqual([{ kind: "tl407_original_missing", date: "2027-03-10" }, item]);
  });
});

/** An attempt with its paper and Agentur. */
const ref = (
  id: string,
  overrides: Partial<Tl407Attempt> & { documentId?: string; agenturKey?: string } = {},
) => ({
  id,
  documentId: "scan-a",
  agenturKey: "nord",
  ...attempt(overrides),
});

describe("retainableOriginal (Q206 (4))", () => {
  const first = ref("first", { originalSentOn: "2027-03-11", rejectedOn: "2027-03-15" });
  const second = ref("second", { submittedOn: "2027-03-16" });

  it("offers the newest earlier dispatch of the same scan to the same Agentur", () => {
    expect(retainableOriginal(second, [second, first])).toEqual({
      submissionId: "first",
      originalSentOn: "2027-03-11",
    });
    const middle = ref("middle", { originalSentOn: "2027-03-13", rejectedOn: "2027-03-14" });
    expect(retainableOriginal(second, [second, middle, first])?.submissionId).toBe("middle");
  });

  it("offers nothing without such a dispatch, nor for an attempt that needs no original", () => {
    expect(retainableOriginal(second, [second, { ...first, originalSentOn: null }])).toBeNull();
    expect(retainableOriginal(second, [second, { ...first, documentId: "scan-b" }])).toBeNull();
    expect(retainableOriginal(second, [second, { ...first, agenturKey: "sued" }])).toBeNull();
    expect(retainableOriginal(second, [second, { ...first, rejectedOn: null }])).toBeNull();
    expect(
      retainableOriginal({ ...second, originalSentOn: "2027-03-16" }, [second, first]),
    ).toBeNull();
    expect(
      retainableOriginal({ ...second, channel: "paper_original" }, [second, first]),
    ).toBeNull();
    expect(retainableOriginal(first, [second, first])).toBeNull();
  });
});
