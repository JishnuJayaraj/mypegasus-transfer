import { describe, expect, it } from "vitest";
import {
  applicableAsuDueDate,
  asuProofState,
  asuRegisteredSince,
  asuRegistrationProblem,
  BaCustomerNumber,
  type AsuRegistrationFacts,
} from "./model";
import { AsuRegistrationInput, isDirectAsuChannel } from "./api";

// Synthetic dates and instants only.
const yesterday = "2027-03-01T09:00:00.000000Z";
const today = "2027-03-02T10:00:00.000000Z";
const later = "2027-03-03T08:00:00.000000Z";

const registration = (proof: AsuRegistrationFacts["proof"]): AsuRegistrationFacts => ({
  registeredOn: "2027-02-20",
  recordedAt: yesterday,
  proof,
});

describe("asuRegisteredSince (process-and-lifecycle.md, guards)", () => {
  it("is recorded with the attestation", () => {
    expect(
      asuRegisteredSince(registration({ kind: "ba_customer_number", linkedAt: yesterday })),
    ).toBe(yesterday);
  });

  it("an old proof linked today gives a fact recorded today, not before (the snapshot rule)", () => {
    const fact = asuRegisteredSince(
      registration({
        kind: "ba_confirmation",
        linkedAt: today,
        document: { usable: true, quarantineLiftedAt: null },
      }),
    );
    expect(fact).toBe(today);
  });

  it("counts from a lifted quarantine of the proving document", () => {
    const fact = asuRegisteredSince(
      registration({
        kind: "ba_confirmation",
        linkedAt: today,
        document: { usable: true, quarantineLiftedAt: later },
      }),
    );
    expect(fact).toBe(later);
  });

  it("gives nothing without a proof, a registration or a usable document", () => {
    expect(asuRegisteredSince(null)).toBeNull();
    expect(asuRegisteredSince(registration(null))).toBeNull();
    expect(
      asuRegisteredSince(
        registration({
          kind: "ba_confirmation",
          linkedAt: today,
          document: { usable: false, quarantineLiftedAt: null },
        }),
      ),
    ).toBeNull();
  });
});

describe("asuProofState (regional-variation.md, the base rules)", () => {
  it("is accepted once a registration with proof exists, without a file", () => {
    expect(asuProofState(true, [])).toEqual(["accepted"]);
    expect(asuProofState(true, ["rejected"])).toEqual(["accepted"]);
  });

  it("otherwise the documents', an accepted unlinked one still awaiting its link", () => {
    expect(asuProofState(false, [])).toEqual([]);
    expect(asuProofState(false, ["uploaded", "accepted", "rejected"])).toEqual([
      "uploaded",
      "uploaded",
      "rejected",
    ]);
  });
});

describe("applicableAsuDueDate (process-and-lifecycle.md, dates)", () => {
  const facts = {
    projectType: "ta_tg" as const,
    status: "informed" as const,
    registered: false,
    endDate: "2027-06-30",
    knowledgeDate: "2027-01-10",
  };

  it("is statutory with a knowledge date, an orientation without", () => {
    expect(applicableAsuDueDate(facts)).toEqual({
      kind: "statutory",
      date: "2027-03-30",
      branch: "reference_date",
    });
    expect(applicableAsuDueDate({ ...facts, knowledgeDate: null })).toEqual({
      kind: "orientation",
      date: "2027-03-30",
    });
  });

  it.each(["imported", "contacted", "unreachable", "informed"] as const)(
    "applies while %s",
    (status) => {
      expect(applicableAsuDueDate({ ...facts, status })).not.toBeNull();
    },
  );

  it.each([
    ["in ta_only", { projectType: "ta_only" as const }],
    ["once in the TG", { status: "active_in_tg" as const }],
    ["after the end", { status: "withdrawn" as const }],
    ["once registered with proof", { registered: true }],
    ["without the end of the old employment", { endDate: null }],
  ])("is gone %s", (_, change) => {
    expect(applicableAsuDueDate({ ...facts, ...change })).toBeNull();
  });
});

const parse = (body: unknown) => AsuRegistrationInput.safeParse(body).success;

describe("the registration's input", () => {
  it("refuses a date after today", () => {
    expect(asuRegistrationProblem("2027-03-03", "2027-03-02")).toBe("registered_on_in_future");
    expect(asuRegistrationProblem("2027-03-02", "2027-03-02")).toBeNull();
  });

  it("takes a BA-Kundennummer of 4–20 letters and digits, trimmed", () => {
    expect(BaCustomerNumber.parse(" 123A456789 ")).toBe("123A456789");
    for (const bad of ["12", "123-456", "x".repeat(21), ""]) {
      expect(BaCustomerNumber.safeParse(bad).success).toBe(false);
    }
  });

  it("needs the attestation's source with its number", () => {
    expect(parse({ registeredOn: "2027-02-20" })).toBe(true);
    expect(
      parse({
        registeredOn: "2027-02-20",
        attestation: { customerNumber: "123A456789", source: "ba_online_account_inspected" },
      }),
    ).toBe(true);
    expect(
      parse({ registeredOn: "2027-02-20", attestation: { customerNumber: "123A456789" } }),
    ).toBe(false);
    expect(
      parse({ attestation: { customerNumber: "123A456789", source: "ba_confirmed_by_phone" } }),
    ).toBe(false);
  });

  it("is direct on online_self and in_person only", () => {
    expect(isDirectAsuChannel("online_self")).toBe(true);
    expect(isDirectAsuChannel("in_person")).toBe(true);
    expect(isDirectAsuChannel("kug_200b")).toBe(false);
    expect(isDirectAsuChannel(null)).toBe(false);
  });
});
