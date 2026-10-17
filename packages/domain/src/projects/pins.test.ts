import { describe, expect, it } from "vitest";
import { PinTemplateInput, planTemplatePin, ProjectConfig } from "./pins";

const catalog = [
  { agenturKey: "nord", version: 1 },
  { agenturKey: "nord", version: 2 },
  { agenturKey: "sued", version: 1 },
];
const draft = { status: "draft", projectAgenturKey: null } as const;
const plan = (
  input: PinTemplateInput,
  options: Partial<Parameters<typeof planTemplatePin>[0]> = {},
) => planTemplatePin({ project: draft, catalog, pins: [], input, ...options });

describe("planTemplatePin (plan 5.8, R12)", () => {
  it("pins an Agentur's latest version unless the PL chooses an older one", () => {
    expect(plan({ agenturKey: "nord" })).toEqual({ pinVersion: 2, setProjectAgentur: false });
    expect(plan({ agenturKey: "nord", version: 1 })).toEqual({
      pinVersion: 1,
      setProjectAgentur: false,
    });
  });

  it("sets the Project Agentur together with its pin, or alone when it is pinned already", () => {
    expect(plan({ agenturKey: "sued", projectAgentur: true })).toEqual({
      pinVersion: 1,
      setProjectAgentur: true,
    });
    const pins = [{ agenturKey: "nord", version: 1 }];
    expect(plan({ agenturKey: "nord", projectAgentur: true }, { pins })).toEqual({
      pinVersion: null,
      setProjectAgentur: true,
    });
    expect(plan({ agenturKey: "nord", version: 1, projectAgentur: true }, { pins })).toEqual({
      pinVersion: null,
      setProjectAgentur: true,
    });
  });

  it("chooses only an Agentur and a version from the catalog", () => {
    expect(plan({ agenturKey: "ost" })).toEqual({
      issues: [{ code: "template_not_in_catalog", field: "agenturKey" }],
    });
    expect(plan({ agenturKey: "sued", version: 2 })).toEqual({
      issues: [{ code: "template_not_in_catalog", field: "version" }],
    });
  });

  it("leaves another version of a pinned Agentur to the migration (2e-2), and refuses a no-op", () => {
    const pins = [{ agenturKey: "nord", version: 1 }];
    expect(plan({ agenturKey: "nord", version: 2, projectAgentur: true }, { pins })).toEqual({
      issues: [{ code: "template_already_pinned", field: "version" }],
    });
    expect(plan({ agenturKey: "nord" }, { pins })).toEqual({
      issues: [{ code: "template_already_pinned", field: "agenturKey" }],
    });
    const project = { status: "draft", projectAgenturKey: "nord" } as const;
    expect(plan({ agenturKey: "nord", projectAgentur: true }, { pins, project })).toEqual({
      issues: [{ code: "template_already_pinned", field: "agenturKey" }],
    });
  });

  it("fixes the Project Agentur once active, but still pins further Agenturen (R1, Q98)", () => {
    const project = { status: "active", projectAgenturKey: "nord" } as const;
    const pins = [{ agenturKey: "nord", version: 1 }];
    expect(plan({ agenturKey: "sued", projectAgentur: true }, { pins, project })).toEqual({
      issues: [{ code: "project_not_draft", field: "projectAgentur" }],
    });
    expect(plan({ agenturKey: "sued" }, { pins, project })).toEqual({
      pinVersion: 1,
      setProjectAgentur: false,
    });
  });
});

describe("PinTemplateInput", () => {
  it("is strict and takes an Agentur key, an optional version and the Project Agentur flag", () => {
    expect(PinTemplateInput.safeParse({ agenturKey: "nord", version: 2 }).success).toBe(true);
    expect(PinTemplateInput.safeParse({ agenturKey: "nord", projectAgentur: true }).success).toBe(
      true,
    );
    for (const input of [
      { agenturKey: "Nord" },
      { agenturKey: "nord", version: 0 },
      { agenturKey: "nord", sha256: "a".repeat(64) },
      { agenturKey: "nord", content: {} },
    ]) {
      expect(PinTemplateInput.safeParse(input).success).toBe(false);
    }
  });
});

describe("ProjectConfig", () => {
  it("describes pins, blockers per Agentur and the activation blockers", () => {
    const config = {
      projectAgenturKey: "nord",
      baseDefaultsVersion: 1,
      pins: [
        {
          agenturKey: "nord",
          version: 1,
          label: { de: "Nord" },
          sha256Prefix: "e5a0727e979a",
          pinnedAt: "2026-10-17T09:00:00.000000Z",
          pinnedBy: "00000000-0000-4000-8000-000000000003",
        },
      ],
      projectBlockers: [],
      agenturen: [
        {
          agenturKey: "nord",
          blockers: [
            {
              code: "agentur_submission_blocked",
              step: "agentur_submission",
              agenturKey: "nord",
              missing: ["leadTimeDays"],
            },
          ],
          warnings: [],
        },
      ],
      activationBlockers: ["no_entry_wave_with_latest_entry_date"],
      capabilities: { pinTemplate: true, setProjectAgentur: false },
    };
    expect(ProjectConfig.parse(config)).toEqual(config);
    const blocked = { ...config, projectBlockers: [{ code: "project_activation_blocked" }] };
    expect(ProjectConfig.safeParse(blocked).success).toBe(false);
    // The submission steps are the domain's Step values (ADR-0004), and only those two.
    const otherStep = {
      ...config,
      agenturen: [
        {
          ...config.agenturen[0]!,
          blockers: [{ ...config.agenturen[0]!.blockers[0]!, step: "dsv" }],
        },
      ],
    };
    expect(ProjectConfig.safeParse(otherStep).success).toBe(false);
  });
});
