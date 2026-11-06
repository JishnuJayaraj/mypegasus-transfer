import { describe, expect, it } from "vitest";
import type { CompletenessRule, RulesByStep } from "../completeness/rules";
import type { WizardInput } from "../self-service/wizard";
import {
  PortalProgress,
  portalProgress,
  progressCount,
  type PortalProgressInput,
} from "./progress";

const required = (field: string) =>
  ({ id: `r-${field}`, kind: "required", field, basis: "ba_form" }) as CompletenessRule;

const rules: RulesByStep = {
  data_collection: [required("address")],
  profiling: [
    required("gender"),
    // a sensitive page's field: complete by its presence only
    required("nationality"),
    { id: "r-cv", kind: "documentPresent", documentType: "cv" },
    // staff's own type: not the participant's task
    { id: "r-asu", kind: "documentPresent", documentType: "asu_proof" },
    {
      id: "r-cert",
      kind: "documentPresent",
      documentType: "qualification_certificate",
      when: { field: "maritalStatus", equals: "married" },
    },
  ],
  dsv: [required("phone")],
};

const wizard = (overrides: Partial<WizardInput> = {}): WizardInput => ({
  projectType: "ta_tg",
  rules,
  customFields: {},
  helpTexts: { de: {}, en: {} },
  fields: {},
  documents: {},
  ...overrides,
});

const input = (overrides: Partial<PortalProgressInput> = {}): PortalProgressInput => ({
  wizard: wizard(),
  noticeAcknowledged: false,
  invitations: [],
  ...overrides,
});

const appointmentId = "00000000-0000-4000-8000-0000000000a1";

describe("portalProgress (the portal home's checklist)", () => {
  it("lists the notice, each page with a required field, the required own uploads and the invitations", () => {
    const progress = portalProgress(
      input({
        invitations: [{ appointmentId, kind: "info_event", booked: false }],
      }),
    );
    expect(progress.tasks).toEqual([
      { kind: "notice", done: false },
      { kind: "section", page: "personal", done: false },
      { kind: "section", page: "contact", done: false },
      { kind: "section", page: "ba_details", done: false },
      { kind: "upload", documentType: "cv", done: false },
      { kind: "appointment", appointmentId, appointmentKind: "info_event", done: false },
    ]);
    expect(progress.optional).toEqual([
      "education",
      "work_history",
      "languages_mobility",
      "job_wish",
      "health",
    ]);
    expect(PortalProgress.parse(progress)).toEqual(progress);
  });

  it("marks tasks done from presence and the completeness result, never from a value", () => {
    const progress = portalProgress(
      input({
        noticeAcknowledged: true,
        wizard: wizard({
          fields: { gender: "female", address: { street: "x" }, nationality: true },
          documents: { cv: ["uploaded"] },
        }),
        invitations: [{ appointmentId, kind: "consultation", booked: true }],
      }),
    );
    expect(progress.tasks.every((task) => task.done)).toBe(true);
    expect(progressCount(progress)).toEqual({ done: 6, total: 6 });
  });

  it("keeps a satisfied required upload as a done task, so the total doesn't move", () => {
    const before = portalProgress(input());
    const after = portalProgress(input({ wizard: wizard({ documents: { cv: ["uploaded"] } }) }));
    expect(progressCount(before)).toEqual({ done: 0, total: 5 });
    expect(progressCount(after)).toEqual({ done: 1, total: 5 });
    // a rejected upload counts as not done
    const rejected = portalProgress(input({ wizard: wizard({ documents: { cv: ["rejected"] } }) }));
    expect(progressCount(rejected)).toEqual({ done: 0, total: 5 });
  });

  it("adds a conditional upload while its condition holds", () => {
    const married = portalProgress(
      input({ wizard: wizard({ fields: { maritalStatus: "married" } }) }),
    );
    expect(married.tasks).toContainEqual({
      kind: "upload",
      documentType: "qualification_certificate",
      done: false,
    });
  });

  it("puts the documents page under optional when no upload is required", () => {
    const progress = portalProgress(input({ wizard: wizard({ rules: {} }) }));
    expect(progress.tasks).toEqual([{ kind: "notice", done: false }]);
    expect(progress.optional).toContain("documents");
    // with a custom field, "further" is listed too
    const withCustom = portalProgress(
      input({
        wizard: wizard({
          rules: {},
          customFields: { "custom.nr": { label: { de: "Nr." }, schema: { type: "string" } } },
        }),
      }),
    );
    expect(withCustom.optional).toContain("further");
  });

  it("never lets an optional item change the counts", () => {
    const empty = portalProgress(input());
    const filledOptional = portalProgress(
      input({
        wizard: wizard({
          fields: { educationHistory: [{ from: "2000" }], jobWishes: { desired: "x" } },
          documents: { participant_upload: ["uploaded"] },
        }),
      }),
    );
    expect(progressCount(filledOptional)).toEqual(progressCount(empty));
  });
});
