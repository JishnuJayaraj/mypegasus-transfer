import { describe, expect, it } from "vitest";
import {
  checkAgenturSetting,
  RemoveAgenturSettingQuery,
  SetAgenturSettingInput,
  settingKeys,
} from "./agentur-settings";

// Slice 2 plan 5.9 (PR 2d-1): an Agentur-scoped setting (round 8, Q93, R14).
const input = {
  expectedVersion: 0,
  settings: { agentur_submission: { leadTimeDays: 7, submissionChannel: "upload" } },
  source: "email_agentur",
  confirmedOn: "2026-10-17",
} as const;

describe("SetAgenturSettingInput", () => {
  it("takes the settings, a source and the confirmation date; never the confirmer", () => {
    expect(SetAgenturSettingInput.parse(input)).toEqual(input);
    for (const wrong of [
      { ...input, confirmedBy: "00000000-0000-4000-8000-000000000003" },
      { ...input, source: "rumour" },
      { ...input, confirmedOn: "17.10.2026" },
      { ...input, expectedVersion: -1 },
      { ...input, settings: { agentur_submission: { leadTimeDays: -1 } } },
      { ...input, settings: { project_checklist: {} } },
    ]) {
      expect(SetAgenturSettingInput.safeParse(wrong).success).toBe(false);
    }
  });

  it("takes the expected version of a removal from the query", () => {
    expect(RemoveAgenturSettingQuery.parse({ expectedVersion: "3" })).toEqual({
      expectedVersion: 3,
    });
    for (const query of [{}, { expectedVersion: "x" }, { expectedVersion: "1", force: "1" }]) {
      expect(RemoveAgenturSettingQuery.safeParse(query).success).toBe(false);
    }
  });
});

describe("checkAgenturSetting (R14)", () => {
  it("lists the keys a setting supplies as step.key, sorted", () => {
    expect(
      settingKeys({
        asu_registration: { batchSubmissionChannel: "upload" },
        agentur_submission: { originalRequired: false, leadTimeDays: 0 },
      }),
    ).toEqual([
      "agentur_submission.leadTimeDays",
      "agentur_submission.originalRequired",
      "asu_registration.batchSubmissionChannel",
    ]);
    expect(
      settingKeys({
        asu_registration: undefined,
        agentur_submission: { leadTimeDays: 0 },
      }),
    ).toEqual(["agentur_submission.leadTimeDays"]);
  });

  it("accepts a setting confirmed today or earlier", () => {
    expect(checkAgenturSetting(input, "2026-10-17")).toEqual([]);
    expect(checkAgenturSetting({ ...input, confirmedOn: "2026-01-01" }, "2026-10-17")).toEqual([]);
  });

  it("refuses a confirmation after today and a setting that supplies nothing", () => {
    expect(
      checkAgenturSetting(
        { settings: { agentur_submission: {} }, confirmedOn: "2026-10-18" },
        "2026-10-17",
      ),
    ).toEqual([
      { code: "settings_empty", field: "settings" },
      { code: "confirmed_on_in_future", field: "confirmedOn" },
    ]);
  });
});
