import { describe, expect, it } from "vitest";
import { accessProfiles, sample } from "../access/profiles";
import {
  assistedFieldAccess,
  restrictWizard,
  sensitiveFieldsWhere,
  staffSelfServiceAccess,
  StartAssistedModeInput,
} from "./assisted";
import { sensitiveFields, sensitiveFieldsOf, type SensitiveField } from "./sensitive";
import { wizardPages, type WizardPage } from "./wizard";

const target = {
  projectId: sample.projectId,
  regionId: sample.regionId,
  participationId: sample.participationId,
};
const profile = (key: string) => accessProfiles.find((p) => p.key === key)!.subject;
const wizardKeys = [...wizardPages.flatMap((p) => p.fields), "custom.beispiel_nr"];
const confidential = wizardKeys.filter((key) => !(sensitiveFields as string[]).includes(key));

/** The wizard keys the profile sees and writes in assisted mode. */
const assistedKeys = (key: string) => wizardKeys.filter(assistedFieldAccess(profile(key), target));

describe("starting assisted mode (Q136)", () => {
  it("needs the confirmation and how, nothing else", () => {
    expect(StartAssistedModeInput.parse({ confirmed: true, how: "phone" })).toEqual({
      confirmed: true,
      how: "phone",
    });
    for (const bad of [
      { confirmed: false, how: "phone" },
      { how: "in_person" },
      { confirmed: true },
      { confirmed: true, how: "video" },
      { confirmed: true, how: "phone", note: "asked for help" },
    ]) {
      expect(StartAssistedModeInput.safeParse(bad).success).toBe(false);
    }
  });
});

describe("assisted-mode fields per role (Q136)", () => {
  it("gives the PL the confidential fields and health/disability, never identifiers or residence_social", () => {
    const baDetails: string[] = sensitiveFieldsOf("ba_details") as SensitiveField[];
    expect(assistedKeys("project_lead")).toEqual(
      wizardKeys.filter((key) => !baDetails.includes(key)),
    );
    expect(assistedKeys("project_lead")).toEqual(expect.arrayContaining(confidential));
  });

  it("gives the assigned consultant every field", () => {
    expect(assistedKeys("consultant")).toEqual(wizardKeys);
  });

  it("gives back office all but health", () => {
    expect(assistedKeys("back_office")).toEqual(
      wizardKeys.filter((key) => key !== "healthRestrictions"),
    );
  });

  it("gives an unassigned consultant, the org roles and participants nothing", () => {
    for (const key of [
      "consultant_unassigned",
      "regional_operations_manager",
      "regional_admin",
      "admin",
      "participant",
    ]) {
      expect([key, assistedKeys(key)]).toEqual([key, []]);
    }
  });

  it("is for the participation it was opened for", () => {
    const other = { ...target, participationId: "participation-b" };
    const consultant = staffWith(["consultant"], [sample.participationId, "participation-b"]);
    expect(wizardKeys.filter(assistedFieldAccess(consultant, other))).toEqual(wizardKeys);
    expect(wizardKeys.filter(assistedFieldAccess(profile("consultant"), other))).toEqual([]);
  });
});

function staffWith(roles: ("consultant" | "project_lead" | "back_office")[], assigned: string[]) {
  return {
    kind: "staff",
    staffUserId: "staff-a",
    orgRoles: new Map(),
    projectRoles: { [sample.projectId]: new Set(roles) },
    assignedParticipationIds: new Set(assigned),
  } as const;
}

const view = (key: string) => {
  const access = staffSelfServiceAccess(profile(key), target);
  return {
    reads: sensitiveFieldsWhere(access.reads),
    knows: sensitiveFieldsWhere(access.knows),
    confidential: access.reads("gender") && access.reads("custom.beispiel_nr"),
  };
};

describe("the staff view in normal mode (data-protection.md, self-service)", () => {
  it("lets the assigned consultant read every sensitive field (a logged read)", () => {
    expect(view("consultant")).toEqual({
      reads: sensitiveFields,
      knows: sensitiveFields,
      confidential: true,
    });
  });

  it("lets back office read all but health", () => {
    const allButHealth = sensitiveFields.filter((key) => key !== "healthRestrictions");
    expect(view("back_office")).toEqual({
      reads: allButHealth,
      knows: allButHealth,
      confidential: true,
    });
  });

  it("shows the PL whether health and disability are given, never their values", () => {
    expect(view("project_lead")).toEqual({
      reads: [],
      knows: ["healthRestrictions", "severeDisability"],
      confidential: true,
    });
  });

  it("shows an unassigned consultant nothing", () => {
    expect(view("consultant_unassigned")).toEqual({ reads: [], knows: [], confidential: false });
  });
});

const page = (name: WizardPage["page"], keys: string[], complete = true): WizardPage => ({
  page: name,
  sensitive: name === "health" || name === "ba_details",
  complete,
  fields: keys.map((key) => ({ key, required: true })),
});
const missing = (key: string) =>
  ({ step: "profiling", ruleId: `r-${key}`, kind: "field", key, reason: "missing" }) as const;
const visible = (key: string) => !["nationality", "pensionInsuranceNumber"].includes(key);
const withoutHealth = (key: string) => visible(key) && key !== "healthRestrictions";

describe("the wizard restricted to what a viewer sees", () => {
  const wizard = {
    pages: [
      page("personal", ["gender", "maritalStatus"], false),
      page("ba_details", ["pensionInsuranceNumber", "nationality"], false),
      page("health", ["healthRestrictions", "severeDisability"], false),
    ],
    missing: [missing("gender"), missing("nationality"), missing("healthRestrictions")],
  };

  it("hides fields, their missing items and pages left empty", () => {
    expect(restrictWizard(wizard, withoutHealth, [])).toEqual({
      pages: [
        page("personal", ["gender", "maritalStatus"], false),
        page("health", ["severeDisability"], true),
      ],
      missing: [missing("gender")],
    });
  });

  it("leaves a fully visible wizard as it is", () => {
    expect(restrictWizard(wizard, () => true, [])).toEqual(wizard);
  });

  const documents: WizardPage = {
    page: "documents",
    sensitive: false,
    complete: false,
    fields: [],
    documentTypes: ["cv", "qualification_certificate"],
  };
  const missingCv = { ...missing("cv"), kind: "document" } as const;
  const withDocuments = {
    pages: [...wizard.pages, documents],
    missing: [...wizard.missing, missingCv],
  };

  it("keeps the documents page with the types the viewer reads, and their missing items", () => {
    expect(restrictWizard(withDocuments, () => true, ["cv", "qualification_certificate"])).toEqual(
      withDocuments,
    );
    expect(restrictWizard(withDocuments, () => true, ["qualification_certificate"])).toEqual({
      pages: [
        ...wizard.pages,
        { ...documents, complete: true, documentTypes: ["qualification_certificate"] },
      ],
      missing: wizard.missing,
    });
  });

  it("drops the documents page for a viewer who reads none of its types", () => {
    expect(restrictWizard(withDocuments, () => true, ["asu_proof"])).toEqual({
      pages: wizard.pages,
      missing: wizard.missing,
    });
  });
});
