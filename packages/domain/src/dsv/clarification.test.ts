import { describe, expect, it } from "vitest";
import type { GuardFacts } from "../lifecycle/guards";
import {
  EntryClarificationEscalationRequest,
  EntryClarificationInstructionRequest,
  EntryClarificationRequestRequest,
  EntryClarificationPendingRequest,
  EntryInstructionCode,
  EntryPendingCode,
  entryClarificationActions,
  entryClarificationOpenedOn,
  type EntryClarificationInput,
  type EntryClarificationRecord,
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

  const row = (stage: EntryClarificationRecord["stage"], openedOn = "2027-04-02") => ({
    stage,
    openedOn,
  });

  it("lets the PL document, or reply, until the case is escalated", () => {
    const at = (clarification: EntryClarificationRecord | null) =>
      entryClarificationActions(input({ clarification })).recordPending;
    expect([null, row("documented"), row("returned")].map(at)).toEqual([true, true, true]);
    expect([row("escalated"), row("instructed")].map(at)).toEqual([false, false]);
  });

  it("escalates only a documented case, again after a reply", () => {
    const at = (clarification: EntryClarificationRecord | null) =>
      entryClarificationActions(input({ clarification })).escalate;
    expect(at(null)).toBe(false);
    expect(at(row("documented"))).toBe(true);
    // The manager's request returns it: the PL replies first, which documents it again.
    expect([row("returned"), row("escalated"), row("instructed")].map(at)).toEqual([
      false,
      false,
      false,
    ]);
  });

  it("asks the manager for an answer only while the case is with them", () => {
    const at = (clarification: EntryClarificationRecord | null) =>
      entryClarificationActions(input({ clarification })).instruct;
    expect([null, row("documented"), row("returned"), row("instructed")].map(at)).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(at(row("escalated"))).toBe(true);
    // The case stays open after an instruction: neither may enter or end the participation.
    expect(entryClarificationActions(input({ clarification: row("instructed") })).open).toBe(true);
  });

  it("keeps an unresolved case open and actionable when the planned start moved on", () => {
    // The start moved to the future: nothing is derived, but the escalation is still unresolved.
    const moved = input({ tgStart: "2027-05-20", latestEntryDate: "2027-06-30" });
    expect(entryClarificationActions(moved).open).toBe(false);
    for (const stage of ["documented", "escalated", "returned"] as const) {
      const actions = entryClarificationActions({
        ...moved,
        clarification: row(stage, "2027-04-02"),
      });
      expect([stage, actions.open, actions.openedOn]).toEqual([stage, true, "2027-04-02"]);
      // Not a guard of the new start: the reconciliation needs a passed start.
      expect(actions.reconciliation).toBe(false);
    }
    const escalated = entryClarificationActions({ ...moved, clarification: row("escalated") });
    expect(escalated.instruct).toBe(true);
    // An instructed case ends with its start, and a case closes with the status.
    expect(entryClarificationActions({ ...moved, clarification: row("instructed") }).open).toBe(
      false,
    );
    expect(
      entryClarificationActions({
        ...moved,
        status: "active_in_tg",
        clarification: row("escalated"),
      }).open,
    ).toBe(false);
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
      revision: 0,
    };
    expect(EntryClarificationPendingRequest.safeParse(ok).success).toBe(true);
    expect(EntryClarificationPendingRequest.safeParse({ ...ok, revision: undefined }).success).toBe(
      false,
    );
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
        revision: 2,
      }).success,
    ).toBe(true);
    // Every write names the revision it read; none is defaulted.
    expect(EntryClarificationEscalationRequest.safeParse({ statusVersion: 3 }).success).toBe(false);
    expect(
      EntryClarificationEscalationRequest.safeParse({ statusVersion: 3, revision: 1 }).success,
    ).toBe(true);
    expect(
      EntryClarificationRequestRequest.safeParse({
        code: "date_unclear",
        source: "Datum unklar",
        statusVersion: 3,
        revision: 2,
      }).success,
    ).toBe(true);
    expect(
      EntryClarificationRequestRequest.safeParse({
        code: "dpo_instruction",
        source: "x",
        statusVersion: 3,
        revision: 2,
      }).success,
    ).toBe(false);
    // The instruction takes no pending code, and the pending request no instruction code.
    expect(
      EntryClarificationInstructionRequest.safeParse({
        code: "awaiting_asu_proof",
        source: "x",
        statusVersion: 3,
        revision: 2,
      }).success,
    ).toBe(false);
  });
});
