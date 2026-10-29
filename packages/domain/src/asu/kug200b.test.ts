import { describe, expect, it } from "vitest";
import { FieldMap } from "../forms/field-map";
import type { FormInput } from "../forms/input";
import { testMeasure } from "../forms/testing";
import {
  checkKug200b,
  kug200bBaNoticeProblem,
  kug200bDeclineProblem,
  kug200bItems,
  kug200bOfferOutcome,
  kug200bWithdrawalProblem,
  type Kug200bOfferFacts,
} from "./kug200b";

// The Kug 200b offer (process-and-lifecycle.md, the Kug 200b offer; Q185, Q197 (8)). Synthetic.

const facts = (overrides: Partial<Kug200bOfferFacts> = {}): Kug200bOfferFacts => ({
  projectType: "ta_tg",
  status: "informed",
  channel: "online_self",
  offeredOn: "2026-11-02",
  signed: false,
  declinedOn: null,
  withdrawals: [],
  ...overrides,
});

describe("kug200bOfferOutcome", () => {
  it("is signed with a usable scan, even after a decline; declined only without one", () => {
    expect(kug200bOfferOutcome({ signed: false, declinedOn: null })).toBeNull();
    expect(kug200bOfferOutcome({ signed: false, declinedOn: "2026-11-03" })).toBe("declined");
    expect(kug200bOfferOutcome({ signed: true, declinedOn: "2026-11-03" })).toBe("signed");
  });
});

describe("kug200bItems", () => {
  it("opens the offer item on another route until an outcome, never on kug_200b", () => {
    expect(kug200bItems(facts())).toEqual([{ kind: "kug200b_offer_open", date: "2026-11-02" }]);
    expect(kug200bItems(facts({ channel: null }))).toHaveLength(1);
    expect(kug200bItems(facts({ channel: "kug_200b" }))).toEqual([]);
    expect(kug200bItems(facts({ declinedOn: "2026-11-03" }))).toEqual([]);
    expect(kug200bItems(facts({ signed: true }))).toEqual([]);
    expect(kug200bItems(facts({ offeredOn: null }))).toEqual([]);
    expect(kug200bItems(facts({ status: "withdrawn" }))).toEqual([]);
  });

  it("keeps the BA notice open from the earliest unnotified withdrawal, also after the end", () => {
    const withdrawals = [
      { receivedOn: "2026-11-20", baNotifiedOn: null },
      { receivedOn: "2026-11-10", baNotifiedOn: "2026-11-11" },
      { receivedOn: "2026-11-15", baNotifiedOn: null },
    ];
    const closed = facts({ signed: true, status: "exited", withdrawals });
    expect(kug200bItems(closed)).toEqual([
      { kind: "kug200b_withdrawal_ba_notice", date: "2026-11-15" },
    ]);
    const notified = withdrawals.map((w) => ({ ...w, baNotifiedOn: "2026-11-21" }));
    expect(kug200bItems(facts({ signed: true, withdrawals: notified }))).toEqual([]);
  });

  it("is nothing in ta_only (Q89)", () => {
    const withdrawals = [{ receivedOn: "2026-11-20", baNotifiedOn: null }];
    expect(kug200bItems(facts({ projectType: "ta_only", withdrawals }))).toEqual([]);
  });
});

describe("the offer's dates", () => {
  const today = "2026-11-20";
  it("refuses future dates, a withdrawal before the declaration and a notice before the receipt", () => {
    expect(kug200bDeclineProblem(today, today)).toBeNull();
    expect(kug200bDeclineProblem("2026-11-21", today)).toBe("declined_on_in_future");
    expect(kug200bWithdrawalProblem("2026-11-10", "2026-11-10", today)).toBeNull();
    expect(kug200bWithdrawalProblem("2026-11-09", "2026-11-10", today)).toBe(
      "received_before_consent",
    );
    expect(kug200bWithdrawalProblem("2026-11-21", "2026-11-10", today)).toBe(
      "received_on_in_future",
    );
    expect(kug200bBaNoticeProblem("2026-11-12", "2026-11-12", today)).toBeNull();
    expect(kug200bBaNoticeProblem("2026-11-11", "2026-11-12", today)).toBe(
      "notified_before_receipt",
    );
    expect(kug200bBaNoticeProblem("2026-11-21", "2026-11-12", today)).toBe("notified_on_in_future");
  });
});

const input = (values: FormInput["values"]): FormInput => ({
  formCode: "kug200b",
  projectType: "ta_tg",
  values,
  tables: {},
});

describe("checkKug200b (Q197 (8))", () => {
  const box = { width: 40, height: 14 };
  const map = FieldMap.parse({
    formCode: "kug200b",
    version: "09-2021",
    label: "Kug 200b 09/2021",
    fontSize: 9,
    minFontSize: 7,
    missingRequired: "blank",
    anlage: null,
    dateRanges: [],
    neverFilled: [],
    entries: [
      {
        key: "firstName",
        label: "3 Vorname",
        kind: "text",
        fields: ["3_txtf_Vorname"],
        required: true,
        box,
        multiline: false,
      },
      {
        key: "city",
        label: "8 Ort",
        kind: "text",
        fields: ["8_txtf_Ort"],
        required: true,
        box,
        multiline: false,
      },
      {
        key: "pensionInsuranceNumber",
        label: "11 Rentenversicherungsnummer",
        kind: "text",
        fields: ["11_txtf_Rentenversicherungsnummer"],
        required: true,
        box,
        multiline: false,
        identifier: { maxLength: 12 },
      },
    ],
  });

  it("lists every blank `*` field and every text that doesn't fit, by key and label", () => {
    const check = checkKug200b(
      input({ firstName: "Ola", city: "Sehr lange Ortsbezeichnung", pensionInsuranceNumber: null }),
      map,
      "2026-11-02",
      testMeasure,
    );
    expect(check.ok && check.checklist).toEqual([
      {
        code: "required_blank",
        key: "pensionInsuranceNumber",
        label: "11 Rentenversicherungsnummer",
      },
      { code: "text_not_fitting", key: "city", label: "8 Ort" },
    ]);
    // The text that doesn't fit stays blank for handwriting, never cut.
    expect(check.ok && check.layout.fields.map((field) => field.name)).toEqual(["3_txtf_Vorname"]);
  });

  it("refuses an error such as an RV-Nummer too long, never cut", () => {
    const check = checkKug200b(
      input({ firstName: "Ola", city: "Ort", pensionInsuranceNumber: "1229075112345" }),
      map,
      "2026-11-02",
      testMeasure,
    );
    expect(check).toEqual({
      ok: false,
      errors: [{ code: "identifier_too_long", key: "pensionInsuranceNumber" }],
    });
  });

  it("takes only a Kug 200b map", () => {
    expect(() =>
      checkKug200b(input({}), { ...map, formCode: "tl407" }, "2026-11-02", testMeasure),
    ).toThrow(RangeError);
  });
});
