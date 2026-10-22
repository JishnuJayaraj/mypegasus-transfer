import { describe, expect, it } from "vitest";
import type { CompletenessRule, RulesByStep } from "../completeness/rules";
import { participantActions, type ActionFacts } from "./actions";

const required = (field: string, extra: Partial<CompletenessRule> = {}) =>
  ({ id: `r-${field}`, kind: "required", field, ...extra }) as CompletenessRule;
const document = (documentType: string, accepted?: boolean) =>
  ({
    id: `d-${documentType}`,
    kind: "documentPresent",
    documentType,
    ...(accepted && { accepted }),
  }) as CompletenessRule;

const facts = (rules: RulesByStep, extra: Partial<ActionFacts> = {}): ActionFacts => ({
  projectType: "ta_tg",
  rules,
  fields: {},
  documents: {},
  customFieldKeys: [],
  ...extra,
});
const everything = () => true;

const knows = (key: string) => key !== "healthRestrictions";

describe("participantActions (process-and-lifecycle.md, participant actions)", () => {
  it("one action per missing field of the wizard's steps, once even when two rules need it", () => {
    const rules: RulesByStep = {
      data_collection: [required("mobile"), required("gender")],
      profiling: [required("mobile", { id: "r-mobile-2" }), required("workHistory")],
      dsv: [required("maritalStatus")],
    };
    expect(participantActions(facts(rules, { fields: { gender: "female" } }), everything)).toEqual([
      { kind: "field", key: "mobile", state: "missing" },
      { kind: "field", key: "workHistory", state: "missing" },
    ]);
  });

  it("names no field the viewer may not know about, and none the participant can't fill in", () => {
    const rules: RulesByStep = {
      data_collection: [required("healthRestrictions"), required("personnelNumber")],
    };
    expect(participantActions(facts(rules), knows)).toEqual([]);
    expect(participantActions(facts(rules), everything)).toEqual([
      { kind: "field", key: "healthRestrictions", state: "missing" },
    ]);
  });

  it("names a missing custom field of the chain", () => {
    const rules = { profiling: [required("custom.badge")] };
    expect(
      participantActions(facts(rules, { customFieldKeys: ["custom.badge"] }), everything),
    ).toEqual([{ kind: "field", key: "custom.badge", state: "missing" }]);
  });

  it("skips a rule of the other project type", () => {
    const rules = { data_collection: [required("mobile", { projectTypes: ["ta_only"] })] };
    expect(participantActions(facts(rules), everything)).toEqual([]);
    expect(participantActions(facts(rules, { projectType: "ta_only" }), everything)).toHaveLength(
      1,
    );
  });

  it("a required type without a live document is missing; all rejected is one rejected action", () => {
    const rules = { data_collection: [document("cv"), document("qualification_certificate")] };
    expect(
      participantActions(
        facts(rules, { documents: { qualification_certificate: ["rejected", "rejected"] } }),
        everything,
      ),
    ).toEqual([
      { kind: "document", key: "cv", state: "missing" },
      { kind: "document", key: "qualification_certificate", state: "rejected" },
    ]);
  });

  it("an upload waiting for its review, or one beside a rejected one, asks nothing", () => {
    const rules = { data_collection: [document("cv", true)] };
    for (const states of [["uploaded"], ["rejected", "uploaded"], ["accepted"]] as const) {
      expect(participantActions(facts(rules, { documents: { cv: states } }), everything)).toEqual(
        [],
      );
    }
  });

  it("a type without a rule is rejected when its only live documents are rejected", () => {
    expect(
      participantActions(
        facts(
          {},
          { documents: { participant_upload: ["rejected"], cv: ["rejected", "accepted"] } },
        ),
        everything,
      ),
    ).toEqual([{ kind: "document", key: "participant_upload", state: "rejected" }]);
  });

  it("staff's document types aren't the participant's actions", () => {
    const rules = { data_collection: [document("dsv_signed_scan")] };
    expect(participantActions(facts(rules), everything)).toEqual([]);
  });
});
