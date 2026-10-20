import { describe, expect, it } from "vitest";
import { OrgRole, ProjectRole } from "../enums";
import {
  ActorType,
  DsvStatus,
  EndReason,
  KugOutcome,
  LifecycleFlag,
  MainStatus,
  ProfilingExceptionReason,
  ProfilingExceptionStatus,
  ProfilingExceptionSupersededReason,
  ProfilingStatus,
  ProjectFlag,
  Step,
  TgEntryKind,
  Track,
  endReasonsForPhase,
  isEndReasonForPhase,
  plannerEndReasons,
  terminalMainStatuses,
} from "./enums";

/** The expected values as they appear in plan 5.2, separated by whitespace. */
const words = ([text = ""]: TemplateStringsArray) => text.trim().split(/\s+/);

describe("vocabulary (plan 5.2)", () => {
  it.each([
    [
      "MainStatus",
      MainStatus,
      words`imported contacted unreachable informed active_in_tg withdrawn ta_completed exited`,
    ],
    [
      "ProfilingStatus",
      ProfilingStatus,
      words`not_started profiling_accepted profiling_in_progress profiling_done profiling_declined`,
    ],
    ["DsvStatus", DsvStatus, words`not_offered dsv_offered dsv_signed dsv_declined dsv_expired`],
    ["Track", Track, words`main profiling dsv`],
    [
      "Step",
      Step,
      words`asu_registration data_collection profiling agentur_submission dsv project_checklist`,
    ],
    ["TgEntryKind", TgEntryKind, words`scheduled_entry scheduled_entry_catchup reconciliation`],
    [
      "ProfilingExceptionReason",
      ProfilingExceptionReason,
      words`participant_prevented_documented agentur_scheduling_unavailable force_majeure
            ba_confirmed_other`,
    ],
    [
      "ProfilingExceptionStatus",
      ProfilingExceptionStatus,
      words`none requested approved rejected revoked superseded`,
    ],
    [
      "ProfilingExceptionSupersededReason",
      ProfilingExceptionSupersededReason,
      words`participation_closed project_ta_only profiling_closed`,
    ],
    ["KugOutcome", KugOutcome, words`eligible excluded ba_review_required`],
    [
      "LifecycleFlag",
      LifecycleFlag,
      words`tg_start_missed cutoff_warning cutoff_final_reminder
            conflict_dsv_signed_profiling_declined dsv_never_offered
            informed_without_wave_at_cutoff profiling_exception_deadline_missed
            profiling_declined_after_entry`,
    ],
    ["ProjectFlag", ProjectFlag, words`latest_entry_date_missing`],
    ["ActorType", ActorType, words`user participant system`],
    ["OrgRole", OrgRole, words`admin regional_admin regional_operations_manager`],
    ["ProjectRole", ProjectRole, words`project_lead consultant back_office`],
  ])("%s has exactly the planned values", (_, schema, values) => {
    expect(schema.options).toEqual(values);
  });

  it("has three terminal main statuses", () => {
    expect([...terminalMainStatuses]).toEqual(words`withdrawn ta_completed exited`);
  });

  it("has no unrestricted exception reason (Q81)", () => {
    for (const code of words`other late_joiner profiler_capacity`) {
      expect(ProfilingExceptionReason.safeParse(code).success).toBe(false);
    }
  });
});

describe("end reasons (Q34, plan 5.2)", () => {
  it("lists the reasons per phase", () => {
    expect(endReasonsForPhase("pre_tg")).toEqual(
      words`declined_profiling declined_dsv no_response never_contacted not_informed placed_direct
            self_employed retirement other_measure deceased other`,
    );
    expect(endReasonsForPhase("tg")).toEqual(
      words`placed_permanent placed_fixed_term self_employed retirement apprenticeship_or_study
            max_duration_reached own_termination_without_job terminated_by_tg
            long_term_illness_reduced_earning_capacity deceased other`,
    );
  });

  it("is one enum: every reason belongs to at least one phase", () => {
    const inPhases = new Set([...endReasonsForPhase("pre_tg"), ...endReasonsForPhase("tg")]);
    expect([...inPhases].toSorted()).toEqual(EndReason.options.toSorted());
  });

  it.each([
    ["declined_dsv", "pre_tg", true],
    ["declined_dsv", "tg", false],
    ["placed_permanent", "tg", true],
    ["placed_permanent", "pre_tg", false],
    ["retirement", "pre_tg", true],
    ["retirement", "tg", true],
  ] as const)("%s in phase %s: %s", (reason, phase, expected) => {
    expect(isEndReasonForPhase(reason, phase)).toBe(expected);
  });

  it("lets the planner derive only five pre-TG reasons, in precedence order", () => {
    expect(plannerEndReasons).toEqual(
      words`declined_dsv declined_profiling no_response never_contacted not_informed`,
    );
    expect(plannerEndReasons.every((reason) => isEndReasonForPhase(reason, "pre_tg"))).toBe(true);
  });
});
