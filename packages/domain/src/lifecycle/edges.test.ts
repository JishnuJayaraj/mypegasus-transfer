import { describe, expect, it } from "vitest";
import { DsvStatus, MainStatus, ProfilingStatus, type Track } from "./enums";
import { edges } from "./edges";
import { context } from "./testing/context";
import { canTransition, type AnyStatus } from "./transition";

// Plan 5.3, "Edges": track from to actor kind [guards] (project type). Restated by hand.
const expected = `
main - imported user manual
main imported contacted user manual
main contacted informed user manual
main contacted unreachable user manual
main unreachable contacted user manual before_cutoff
main informed active_in_tg system scheduled_entry dsv_fully_executed,asu_registered_with_proof,profiling_done_or_approved_exception,tg_start_date ta_tg
main informed active_in_tg system scheduled_entry_catchup dsv_fully_executed,asu_registered_with_proof,profiling_done_or_approved_exception,tg_start_date ta_tg
main informed active_in_tg user reconciliation dsv_fully_executed,asu_registered_with_proof,profiling_done_or_approved_exception,tg_start_date ta_tg
main informed ta_completed user manual ta_completion ta_only
main active_in_tg exited user manual
main imported withdrawn user manual withdrawal_after_dsv_signed
main imported withdrawn system system withdrawal_after_dsv_signed
main contacted withdrawn user manual withdrawal_after_dsv_signed
main contacted withdrawn system system withdrawal_after_dsv_signed
main unreachable withdrawn user manual withdrawal_after_dsv_signed
main unreachable withdrawn system system withdrawal_after_dsv_signed
main informed withdrawn user manual withdrawal_after_dsv_signed
main informed withdrawn system system withdrawal_after_dsv_signed
profiling not_started profiling_accepted user manual
profiling not_started profiling_declined user manual
profiling profiling_accepted profiling_in_progress user manual
profiling profiling_accepted profiling_declined user manual
profiling profiling_in_progress profiling_done user manual tl407_signed
profiling profiling_in_progress profiling_declined user manual
profiling profiling_declined profiling_accepted user manual before_cutoff
dsv not_offered dsv_offered user manual entry_wave_assigned,dsv_generated,offer_deadline_valid
dsv dsv_offered dsv_signed user manual dsv_scan_received
dsv dsv_offered dsv_declined user manual
dsv dsv_offered dsv_expired system system
dsv dsv_declined dsv_offered user manual before_cutoff,offer_deadline_valid
dsv dsv_expired dsv_offered user manual before_cutoff,offer_deadline_valid`
  .trim()
  .split("\n");

const statuses: Record<Track, readonly AnyStatus[]> = {
  main: MainStatus.options,
  profiling: ProfilingStatus.options,
  dsv: DsvStatus.options,
};
const field = { main: "status", profiling: "profilingStatus", dsv: "dsvStatus" } as const;

describe("edges (AC-1)", () => {
  it("are exactly the plan's edge table", () => {
    const rows = edges.map((e) =>
      [e.track, e.from ?? "-", e.to, e.actor, e.kind, e.guards.join(","), e.projectTypes?.join(",")]
        .filter(Boolean)
        .join(" "),
    );
    expect(rows).toEqual(expected);
  });

  it.each(["ta_tg", "ta_only"] as const)(
    "%s: every (track, from, to) pair outside the table is no_edge",
    (projectType) => {
      const allowed = new Set(
        edges
          .filter((e) => e.from && (!e.projectTypes || e.projectTypes.includes(projectType)))
          .map((e) => `${e.track} ${e.from} ${e.to}`),
      );
      const mismatches: string[] = [];
      let pairs = 0;
      for (const track of ["main", "profiling", "dsv"] as const) {
        for (const from of statuses[track]) {
          for (const to of statuses[track]) {
            pairs++;
            const ctx = context({ projectType });
            const current = { ...ctx.current, [field[track]]: from };
            const result = canTransition(track, from, to, { ...ctx, current });
            const noEdge = !result.ok && result.code === "no_edge";
            if (noEdge === allowed.has(`${track} ${from} ${to}`))
              mismatches.push(`${track} ${from} ${to}`);
          }
        }
      }
      expect(pairs).toBe(8 ** 2 + 5 ** 2 + 5 ** 2);
      expect(mismatches).toEqual([]);
    },
  );

  it("refuses a `from` that isn't the current status", () => {
    expect(() => canTransition("main", "imported", "contacted", context())).toThrow(
      "from (imported) is not the current status",
    );
  });
});
