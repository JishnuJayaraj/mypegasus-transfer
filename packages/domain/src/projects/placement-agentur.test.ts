import { describe, expect, it } from "vitest";
import { MainStatus, terminalMainStatuses } from "../lifecycle/enums";
import {
  placementAgenturCapability,
  placementAgenturChoices,
  planPlacementAgentur,
  SetPlacementAgenturInput,
} from "./placement-agentur";

const catalog = [
  { agenturKey: "nord", version: 1, label: { de: "Nord v1" } },
  { agenturKey: "nord", version: 2, label: { de: "Nord" } },
  { agenturKey: "sued", version: 1, label: { de: "Süd" } },
];
const open = { status: "informed", placementAgenturKey: null } as const;
const plan = (
  agenturKey: string,
  options: Partial<Parameters<typeof planPlacementAgentur>[0]> = {},
) => planPlacementAgentur({ participation: open, catalog, pins: [], agenturKey, ...options });

describe("planPlacementAgentur (Q139, regional-variation.md)", () => {
  it("pins an unpinned catalog Agentur at its latest version", () => {
    expect(plan("nord")).toEqual({ ok: true, pinVersion: 2 });
    expect(plan("sued")).toEqual({ ok: true, pinVersion: 1 });
  });

  it("uses the project's pin of an Agentur it has pinned, whatever the catalog's latest", () => {
    expect(plan("nord", { pins: [{ agenturKey: "nord" }] })).toEqual({
      ok: true,
      pinVersion: null,
    });
  });

  it("accepts a key without a template and pins nothing", () => {
    expect(plan("ost")).toEqual({ ok: true, pinVersion: null });
  });

  it("changes the key while the participation isn't terminal", () => {
    const placed = { status: "active_in_tg", placementAgenturKey: "nord" } as const;
    expect(plan("sued", { participation: placed })).toEqual({ ok: true, pinVersion: 1 });
  });

  it("refuses a terminal participation, then the same key again", () => {
    for (const status of terminalMainStatuses) {
      expect(plan("nord", { participation: { status, placementAgenturKey: null } })).toEqual({
        ok: false,
        code: "participation_closed",
      });
    }
    expect(plan("nord", { participation: { ...open, placementAgenturKey: "nord" } })).toEqual({
      ok: false,
      code: "placement_agentur_unchanged",
    });
  });
});

describe("placementAgenturCapability", () => {
  it("is the permission first, then the open participation", () => {
    expect(placementAgenturCapability("informed", false)).toBe(false);
    for (const status of MainStatus.options) {
      expect(placementAgenturCapability(status, true)).toBe(!terminalMainStatuses.has(status));
    }
  });
});

describe("placementAgenturChoices", () => {
  it("lists each catalog Agentur and each pinned one, with the pinned and the latest version", () => {
    const pins = [
      { agenturKey: "nord", version: 1, label: { de: "Nord v1" } },
      { agenturKey: "alt", version: 3, label: { de: "Alt" } },
    ];
    expect(placementAgenturChoices(catalog, pins)).toEqual([
      { agenturKey: "alt", label: { de: "Alt" }, pinnedVersion: 3, latestVersion: null },
      { agenturKey: "nord", label: { de: "Nord v1" }, pinnedVersion: 1, latestVersion: 2 },
      { agenturKey: "sued", label: { de: "Süd" }, pinnedVersion: null, latestVersion: 1 },
    ]);
  });
});

describe("SetPlacementAgenturInput", () => {
  it("takes one Agentur key in the template key format, nothing else", () => {
    expect(SetPlacementAgenturInput.safeParse({ agenturKey: "beispielstadt-nord" }).success).toBe(
      true,
    );
    for (const body of [
      { agenturKey: "Beispielstadt" },
      { agenturKey: "nord-" },
      { agenturKey: "" },
      { agenturKey: "nord", version: 1 },
      {},
    ]) {
      expect(SetPlacementAgenturInput.safeParse(body).success).toBe(false);
    }
  });
});
