import { describe, expect, it } from "vitest";
import { addDays } from "../dates";
import type { IsoDate } from "../iso-date";
import { LifecycleFlag } from "../lifecycle/enums";
import { lifecycleFlags, type ParticipationSnapshot } from "../lifecycle/planner";
import { wave } from "../lifecycle/testing/context";
import { project, snapshot, state } from "../lifecycle/testing/planner";
import type { PrivacyNoticeState } from "../privacy/notice-state";
import {
  deadlinesOf,
  deadlineWarningDays,
  mostUrgent,
  remainingFlags,
  type Deadline,
  type DeadlineKind,
} from "./deadlines";

// Synthetic dates. The wave: signing deadline 2027-03-15, TG start 2027-04-01, latest entry
// 2027-04-30. Berlin changes to summer time on 2027-03-28 and back on 2027-10-31.
const provided: PrivacyNoticeState = {
  state: "provided",
  dueOn: "2027-01-01",
  providedAt: "2026-12-01T09:00:00.000Z",
};
const approved = { validOn: "2027-03-20", recordedAt: new Date("2027-03-20T09:00:00Z") };

/** One participation whose only applicable deadline is `kind`, on its date. */
const only: Record<DeadlineKind, { date: IsoDate; s: ParticipationSnapshot; notice?: IsoDate }> = {
  offer_deadline: {
    date: "2027-03-15",
    // Signed nothing yet, but the TG start and cutoff are out of the way (no wave cutoff).
    s: snapshot({
      current: state("informed", "not_started", "dsv_offered"),
      wave: { ...wave, defaultTgStart: null, latestEntryDate: null },
    }),
  },
  tg_start: {
    date: "2027-04-01",
    s: snapshot({
      current: state("informed", "profiling_done", "dsv_signed"),
      wave: { ...wave, latestEntryDate: null },
    }),
  },
  latest_entry_cutoff: {
    date: "2027-04-30",
    s: snapshot({ current: state("contacted"), wave: { ...wave, defaultTgStart: null } }),
  },
  privacy_notice: {
    date: "2027-10-31",
    s: snapshot({ current: state("active_in_tg", "profiling_done", "dsv_signed"), wave: null }),
    notice: "2027-10-31",
  },
  profiling_exception: {
    date: "2027-05-01",
    s: snapshot({
      current: state("active_in_tg", "profiling_in_progress", "dsv_signed"),
      participation: { tgStart: null, offerDeadline: null, tgEntryDate: "2027-04-01" },
      facts: { profilingExceptionApproved: approved },
    }),
  },
};

const notice = (dueOn: IsoDate | undefined): PrivacyNoticeState =>
  dueOn ? { state: "due", dueOn, providedAt: null } : provided;

const at = (kind: DeadlineKind, daysBefore: number) => {
  const { date, s, notice: dueOn } = only[kind];
  const facts = {
    snapshot: s,
    project: { ...project, waves: [s.wave ?? wave] },
    privacyNotice: notice(dueOn),
  };
  return deadlinesOf(facts, addDays(date, -daysBefore));
};

const facts = (s: ParticipationSnapshot) => ({
  snapshot: s,
  project: { type: "ta_only" as const, waves: [] },
  privacyNotice: provided,
});

const final = (days: number) => at("latest_entry_cutoff", days)[0]!.final;

describe("deadlinesOf (process-and-lifecycle.md, deadline warnings)", () => {
  it.each(Object.keys(only) as DeadlineKind[])(
    "%s: not listed at 15 days, upcoming at 14 and 0, overdue at -1",
    (kind) => {
      const { date } = only[kind];
      expect(deadlineWarningDays).toBe(14);
      expect(at(kind, 15)).toEqual([]);
      for (const days of [14, 0]) {
        expect(at(kind, days).map(({ final: _, ...d }) => d)).toEqual([
          { kind, date, state: "upcoming" },
        ]);
      }
      expect(at(kind, -1).map(({ final: _, ...d }) => d)).toEqual([
        { kind, date, state: "overdue" },
      ]);
    },
  );

  it("counts calendar days across a DST change", () => {
    // 2027-03-17 → 2027-04-01 and 2027-10-17 → 2027-10-31 both span a clock change.
    expect(
      deadlinesOf({ snapshot: only.tg_start.s, project, privacyNotice: provided }, "2027-03-18"),
    ).toEqual([{ kind: "tg_start", date: "2027-04-01", state: "upcoming" }]);
    expect(at("privacy_notice", 14)).toEqual([
      { kind: "privacy_notice", date: "2027-10-31", state: "upcoming" },
    ]);
  });

  it("marks the cutoff's final reminder from 3 days before the cutoff, while it is upcoming", () => {
    expect([final(3), final(2), final(0), final(-1)]).toEqual([false, true, true, false]);
  });

  it("an offer without a deadline, a provided notice and a profiling done list nothing", () => {
    const offered = snapshot({
      current: state("informed", "not_started", "dsv_offered"),
      wave: null,
    });
    expect(deadlinesOf(facts(offered), "2027-03-15")).toEqual([]);
    const done = {
      ...only.profiling_exception.s,
      current: state("active_in_tg", "profiling_done", "dsv_signed"),
    };
    expect(deadlinesOf(facts(done), "2027-05-01")).toEqual([]);
    const declined = {
      ...done,
      current: state("active_in_tg", "profiling_declined", "dsv_signed"),
    };
    expect(deadlinesOf(facts(declined), "2027-05-01")).toEqual([]);
    const notEntered = {
      ...only.profiling_exception.s,
      participation: { tgStart: null, offerDeadline: null },
    };
    expect(deadlinesOf(facts(notEntered), "2027-05-01")).toEqual([]);
    const noException = { ...only.profiling_exception.s, facts: {} };
    expect(deadlinesOf(facts(noException), "2027-05-01")).toEqual([]);
  });

  it("ta_only has no cutoff, offer or TG start", () => {
    const s = snapshot({ current: state("contacted"), wave: null });
    expect(
      deadlinesOf(
        { snapshot: s, project: { type: "ta_only", waves: [] }, privacyNotice: provided },
        "2027-04-30",
      ),
    ).toEqual([]);
  });

  it("lists every applicable deadline in kind order", () => {
    const s = snapshot({ current: state("informed", "not_started", "dsv_offered") });
    const due: PrivacyNoticeState = { state: "overdue", dueOn: "2027-03-01", providedAt: null };
    expect(deadlinesOf({ snapshot: s, project, privacyNotice: due }, "2027-03-20")).toEqual([
      { kind: "offer_deadline", date: "2027-03-15", state: "overdue" },
      { kind: "tg_start", date: "2027-04-01", state: "upcoming" },
      { kind: "privacy_notice", date: "2027-03-01", state: "overdue" },
    ]);
  });
});

const d = (kind: DeadlineKind, date: IsoDate, when: Deadline["state"]): Deadline => ({
  kind,
  date,
  state: when,
});

describe("mostUrgent", () => {
  it("takes the oldest overdue deadline first", () => {
    expect(
      mostUrgent([
        d("tg_start", "2027-04-02", "upcoming"),
        d("offer_deadline", "2027-03-15", "overdue"),
        d("privacy_notice", "2027-03-01", "overdue"),
      ]),
    ).toEqual(d("privacy_notice", "2027-03-01", "overdue"));
  });

  it("else the earliest upcoming one; a tie by kind order; none without deadlines", () => {
    expect(
      mostUrgent([
        d("privacy_notice", "2027-04-01", "upcoming"),
        d("tg_start", "2027-04-01", "upcoming"),
        d("latest_entry_cutoff", "2027-04-10", "upcoming"),
      ]),
    ).toEqual(d("tg_start", "2027-04-01", "upcoming"));
    expect(
      mostUrgent([
        d("profiling_exception", "2027-03-01", "overdue"),
        d("offer_deadline", "2027-03-01", "overdue"),
      ]),
    ).toEqual(d("offer_deadline", "2027-03-01", "overdue"));
    expect(mostUrgent([])).toBeNull();
  });
});

describe("remainingFlags: a deadline replaces its flag", () => {
  it("keeps the flags no deadline represents", () => {
    expect(remainingFlags(LifecycleFlag.options)).toEqual([
      "conflict_dsv_signed_profiling_declined",
      "dsv_never_offered",
      "informed_without_wave_at_cutoff",
      "profiling_declined_after_entry",
    ]);
  });

  it("a replaced flag always comes with its deadline, so a cutoff is counted once", () => {
    const replaced: Partial<Record<LifecycleFlag, DeadlineKind>> = {
      tg_start_missed: "tg_start",
      cutoff_warning: "latest_entry_cutoff",
      cutoff_final_reminder: "latest_entry_cutoff",
      profiling_exception_deadline_missed: "profiling_exception",
    };
    const cases: [ParticipationSnapshot, IsoDate][] = [
      [only.tg_start.s, "2027-04-05"],
      [only.latest_entry_cutoff.s, "2027-04-29"],
      [only.profiling_exception.s, "2027-05-20"],
    ];
    for (const [s, today] of cases) {
      const flags = lifecycleFlags(s, project, today);
      const kinds = deadlinesOf({ snapshot: s, project, privacyNotice: provided }, today).map(
        (x) => x.kind,
      );
      expect(flags.length).toBeGreaterThan(0);
      for (const flag of flags) expect(kinds).toContain(replaced[flag]);
      expect(remainingFlags(flags)).toEqual([]);
    }
  });
});
