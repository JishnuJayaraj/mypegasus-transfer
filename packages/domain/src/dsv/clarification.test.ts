import { describe, expect, it } from "vitest";
import type { GuardFacts } from "../lifecycle/guards";
import {
  EntryClarificationInstructionRequest,
  EntryClarificationPendingRequest,
  EntryInstructionCode,
  EntryPendingCode,
  entryClarificationActions,
  entryClarificationOpenedOn,
  type EntryClarificationInput,
} from "./clarification";

// The entry clarification (process-and-lifecycle.md, the entry clarification): opens the day after
// the planned TG start for a signed DSV still `informed`; offers only the paths whose guards pass.

const fact = (validOn: string) => ({ validOn, recordedAt: new Date(`${validOn}T08:00:00Z`) });
const held: GuardFacts = {
  dsvFullyExecuted: fact("2027-03-20"),
  asuRegisteredWithProof: fact("2027-03-21"),
  profilingDone: fact("2027-03-22"),
};

const input = (overrides: Partial<EntryClarificationInput> = {}): EntryClarificationInput => ({
  projectType: "ta_tg",
  status: "informed",
  dsvStatus: "dsv_signed",
  tgStart: "2027-04-01",
  latestEntryDate: "2027-04-30",
  today: "2027-04-02",
  entryRunCompletedToday: true,
  facts: held,
  clarification: null,
  ...overrides,
});

describe("entryClarificationOpenedOn", () => {
  it("is the day after the planned start of a signed DSV still informed", () => {
    expect(entryClarificationOpenedOn(input())).toBe("2027-04-02");
  });

  it("is not open on the planned start itself, or before", () => {
    expect(entryClarificationOpenedOn(input({ today: "2027-04-01" }))).toBeNull();
    expect(entryClarificationOpenedOn(input({ today: "2027-03-01" }))).toBeNull();
  });

  it("stays open until the participation leaves informed, whatever the date", () => {
    expect(entryClarificationOpenedOn(input({ today: "2027-09-01" }))).toBe("2027-04-02");
    for (const status of ["active_in_tg", "withdrawn", "exited", "ta_completed"] as const) {
      expect(entryClarificationOpenedOn(input({ status }))).toBeNull();
    }
  });

  it.each(["not_offered", "dsv_offered", "dsv_declined", "dsv_expired"] as const)(
    "does not concern a DSV track %s",
    (dsvStatus) => {
      expect(entryClarificationOpenedOn(input({ dsvStatus }))).toBeNull();
    },
  );

  it("needs a ta_tg project and a planned start", () => {
    expect(entryClarificationOpenedOn(input({ projectType: "ta_only" }))).toBeNull();
    expect(entryClarificationOpenedOn(input({ tgStart: null }))).toBeNull();
  });
});

describe("entryClarificationActions", () => {
  it("offers nothing while no clarification is open", () => {
    expect(entryClarificationActions(input({ today: "2027-04-01" }))).toEqual({
      open: false,
      openedOn: null,
      reconciliation: false,
      newStartDate: false,
      recordPending: false,
      escalate: false,
      instruct: false,
    });
  });

  it("offers the reconciliation only when every fact held on the planned start", () => {
    expect(entryClarificationActions(input()).reconciliation).toBe(true);
    // The packet became valid after the start: it did not hold on the TG start.
    const late = { ...held, dsvFullyExecuted: fact("2027-04-02") };
    expect(entryClarificationActions(input({ facts: late })).reconciliation).toBe(false);
    for (const key of ["dsvFullyExecuted", "asuRegisteredWithProof"] as const) {
      const { [key]: _, ...without } = held;
      expect(entryClarificationActions(input({ facts: without })).reconciliation).toBe(false);
    }
    // Without profiling_done or an approved exception.
    const { profilingDone: _, ...noProfiling } = held;
    expect(entryClarificationActions(input({ facts: noProfiling })).reconciliation).toBe(false);
    const exception = { ...noProfiling, profilingExceptionApproved: fact("2027-03-30") };
    expect(entryClarificationActions(input({ facts: exception })).reconciliation).toBe(true);
  });

  it("offers a new start date while the latest entry date allows one", () => {
    expect(entryClarificationActions(input()).newStartDate).toBe(true);
    // Today's entry run completed: tomorrow at the earliest.
    const last = input({ today: "2027-04-30", entryRunCompletedToday: true });
    expect(entryClarificationActions(last).newStartDate).toBe(false);
    expect(entryClarificationActions({ ...last, entryRunCompletedToday: false }).newStartDate).toBe(
      true,
    );
    expect(entryClarificationActions(input({ today: "2027-05-01" })).newStartDate).toBe(false);
    expect(entryClarificationActions(input({ latestEntryDate: null })).newStartDate).toBe(false);
  });

  it("lets the PL document what is pending until the case is escalated", () => {
    expect(entryClarificationActions(input()).recordPending).toBe(true);
    const recorded = input({
      clarification: { pending: true, escalated: false, instructed: false },
    });
    expect(entryClarificationActions(recorded).recordPending).toBe(true);
    const escalated = input({
      clarification: { pending: true, escalated: true, instructed: false },
    });
    expect(entryClarificationActions(escalated).recordPending).toBe(false);
    const instructed = input({
      clarification: { pending: true, escalated: true, instructed: true },
    });
    expect(entryClarificationActions(instructed).recordPending).toBe(false);
  });

  it("escalates only a documented case, once", () => {
    expect(entryClarificationActions(input()).escalate).toBe(false);
    const recorded = input({
      clarification: { pending: true, escalated: false, instructed: false },
    });
    expect(entryClarificationActions(recorded).escalate).toBe(true);
    const escalated = input({
      clarification: { pending: true, escalated: true, instructed: false },
    });
    expect(entryClarificationActions(escalated).escalate).toBe(false);
  });

  it("asks the manager for an instruction only after the escalation, once", () => {
    const recorded = input({
      clarification: { pending: true, escalated: false, instructed: false },
    });
    expect(entryClarificationActions(recorded).instruct).toBe(false);
    const escalated = input({
      clarification: { pending: true, escalated: true, instructed: false },
    });
    expect(entryClarificationActions(escalated).instruct).toBe(true);
    const instructed = input({
      clarification: { pending: true, escalated: true, instructed: true },
    });
    expect(entryClarificationActions(instructed).instruct).toBe(false);
    // The case stays open after the instruction: neither may enter or end the participation.
    expect(entryClarificationActions(instructed).open).toBe(true);
  });
});

describe("the requests", () => {
  it("take the codes of the plan and a documented source line", () => {
    expect(EntryPendingCode.options).toEqual([
      "awaiting_countersignature",
      "awaiting_asu_proof",
      "awaiting_profiling",
      "awaiting_legal_advice",
    ]);
    expect(EntryInstructionCode.options).toEqual([
      "legal_advice_obtained",
      "dpo_instruction",
      "authority_or_court_decision",
      "parties_agreement",
    ]);
    const ok = {
      code: "awaiting_asu_proof",
      source: "Akte 12, Vermerk vom 3.4.",
      statusVersion: 3,
    };
    expect(EntryClarificationPendingRequest.safeParse(ok).success).toBe(true);
    expect(EntryClarificationPendingRequest.safeParse({ ...ok, source: "  " }).success).toBe(false);
    expect(
      EntryClarificationPendingRequest.safeParse({ ...ok, source: "x".repeat(201) }).success,
    ).toBe(false);
    expect(EntryClarificationPendingRequest.safeParse({ ...ok, source: "a\nb" }).success).toBe(
      false,
    );
    expect(EntryClarificationPendingRequest.safeParse({ ...ok, code: "other" }).success).toBe(
      false,
    );
    expect(
      EntryClarificationInstructionRequest.safeParse({
        code: "dpo_instruction",
        source: "DSB-Vermerk 7",
        statusVersion: 3,
      }).success,
    ).toBe(true);
    // The instruction takes no pending code, and the pending request no instruction code.
    expect(
      EntryClarificationInstructionRequest.safeParse({
        code: "awaiting_asu_proof",
        source: "x",
        statusVersion: 3,
      }).success,
    ).toBe(false);
  });
});
