import { readFileSync } from "node:fs";
import {
  asuDueDateDefaults,
  cutoffFinalReminderDays,
  cutoffWarningDays,
  evaluateCompleteness,
  profilingExceptionDeadlineMonths,
  type ProjectType,
} from "@transfer/domain";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { renderJsonSchema } from "./json-schema";
import { parseLayer } from "./validate";

const read = (path: string): unknown =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const committedSchema = readFileSync(
  new URL("../schema/regional-template.schema.json", import.meta.url),
  "utf8",
);
const baseDefaults = read("../../domain/config/base-defaults.json");

describe("the committed JSON Schema (AC-31)", () => {
  it("matches the Zod model (pnpm generate)", () => {
    expect(committedSchema).toBe(renderJsonSchema());
  });

  it("validates base-defaults.json", () => {
    const compiled = z.fromJSONSchema(JSON.parse(committedSchema));
    expect(compiled.safeParse(baseDefaults).success).toBe(true);
    // and rejects what the model rejects structurally
    expect(compiled.safeParse({ ...(baseDefaults as object), settings: {} }).success).toBe(false);
  });
});

describe("base-defaults.json (plan 5.7)", () => {
  const result = parseLayer(baseDefaults);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  const layer = result.layer;
  if (layer.kind !== "base_defaults") throw new Error("not the base defaults");

  it("holds no Agentur submission or other regional setting (round 8)", () => {
    expect(Object.keys(layer)).not.toContain("settings");
    expect(JSON.stringify(layer)).not.toMatch(
      /defaultChannel|batchSubmissionChannel|submissionChannel|originalRequired|leadTimeDays|rejectsOutdatedFormVersions/,
    );
  });

  it("states the nationwide settings the domain applies", () => {
    expect(layer.nationwide).toEqual({
      asuDueDate: asuDueDateDefaults, // verify Q1
      profilingExceptionDeadlineMonths, // Q17
      kug200bConfirmationFollowUpDays: 14,
      tl407EscalationDaysAfterTgStart: 14, // Q54
      cutoffWarningDays, // Q78
      cutoffFinalReminderDays,
    });
  });

  it("classifies every base rule and scopes the TG-only ones (round 14)", () => {
    const rules = Object.entries(layer.rules ?? {}).flatMap(([step, list]) =>
      list.map((rule) => ({
        step,
        id: rule.id,
        basis: rule.basis,
        key: rule.kind === "documentPresent" ? rule.documentType : rule.field,
        projectTypes: rule.projectTypes,
      })),
    );
    const tg = ["ta_tg"];
    expect(rules).toEqual([
      {
        step: "asu_registration",
        id: "base-asu-proof",
        basis: "statutory",
        key: "asu_proof",
        projectTypes: tg,
      },
      ...[
        "personnelNumber",
        "lastName",
        "firstName",
        "birthDate",
        "oldEmploymentEndDate",
        "address",
      ].map((key) => ({
        step: "data_collection",
        id: `base-import-${key}`,
        basis: "operational_default",
        key,
        projectTypes: undefined,
      })),
      {
        step: "dsv",
        id: "base-dsv-signed-scan",
        basis: "statutory",
        key: "dsv_signed_scan",
        projectTypes: tg,
      },
    ]);
  });

  it("leaves out the Kug 200b rules until the ASU route and the offer outcome exist (Slice 6)", () => {
    expect(JSON.stringify(layer.rules)).not.toMatch(/kug200b|pensionInsuranceNumber/);
  });

  const missing = (projectType: ProjectType) =>
    Object.values(
      evaluateCompleteness(layer.rules ?? {}, { projectType, fields: {}, documents: {} }).byStep,
    )
      .flatMap((step) => step.missing)
      .map((item) => item.ruleId);

  it("shows no TG-only item in a ta_only project", () => {
    const imports = missing("ta_only");
    expect(imports).toHaveLength(6);
    expect(imports.every((id) => id.startsWith("base-import-"))).toBe(true);
    expect(missing("ta_tg")).toEqual(["base-asu-proof", ...imports, "base-dsv-signed-scan"]);
  });

  it("requires accepted documents", () => {
    const documentRules = Object.values(layer.rules ?? {})
      .flat()
      .filter((rule) => rule.kind === "documentPresent");
    expect(documentRules.every((rule) => rule.accepted === true)).toBe(true);
  });
});
