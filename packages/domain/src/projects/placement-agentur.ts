import { z } from "zod";
import { terminalMainStatuses, type MainStatus } from "../lifecycle/enums";
import { AgenturKey } from "./agentur-settings";

/**
 * `PUT /participations/{id}/placement-agentur` (Q139): any Agentur key in the template key format,
 * from the catalog or not. Strict: a pinned version always comes from the release, never from the
 * client.
 */
export const SetPlacementAgenturInput = z
  .strictObject({ agenturKey: AgenturKey })
  .meta({ id: "SetPlacementAgenturInput" });
export type SetPlacementAgenturInput = z.infer<typeof SetPlacementAgenturInput>;

export type PlacementAgenturRefusal = "participation_closed" | "placement_agentur_unchanged";
export type PlacementAgenturPlan =
  | { ok: true; pinVersion: number | null }
  | { ok: false; code: PlacementAgenturRefusal };

type TemplateRef = { agenturKey: string; version: number };
type Label = { de: string; en?: string };

/**
 * What setting the placement Agentur does (Q139; regional-variation.md, "Placement Agentur"):
 * refused for a terminal participation and for its current key; otherwise it pins a catalog
 * Agentur the project hasn't pinned at its latest version (`pinVersion`), and nothing for a pinned
 * Agentur (its pinned version stays; a newer one is a migration) or a key without a template.
 */
export function planPlacementAgentur(state: {
  participation: { status: MainStatus; placementAgenturKey: string | null };
  /** The release's catalog. */
  catalog: readonly TemplateRef[];
  /** The project's current pin per Agentur. */
  pins: readonly { agenturKey: string }[];
  agenturKey: string;
}): PlacementAgenturPlan {
  const { participation, agenturKey } = state;
  if (terminalMainStatuses.has(participation.status)) {
    return { ok: false, code: "participation_closed" };
  }
  if (participation.placementAgenturKey === agenturKey) {
    return { ok: false, code: "placement_agentur_unchanged" };
  }
  if (state.pins.some((pin) => pin.agenturKey === agenturKey))
    return { ok: true, pinVersion: null };
  const versions = state.catalog.filter((t) => t.agenturKey === agenturKey).map((t) => t.version);
  return { ok: true, pinVersion: versions.length ? Math.max(...versions) : null };
}

/** Whether the viewer may set it now: the permission, then a participation that isn't terminal. */
export const placementAgenturCapability = (status: MainStatus, permitted: boolean) =>
  permitted && !terminalMainStatuses.has(status);

/** One Agentur the detail offers (Q139): the project's pin, else the catalog's latest version. */
export const PlacementAgenturChoice = z
  .strictObject({
    agenturKey: AgenturKey,
    label: z.strictObject({ de: z.string(), en: z.string().optional() }),
    /** The project's pinned version; choosing it keeps that version. */
    pinnedVersion: z.int().min(1).nullable(),
    /** The catalog's latest version, pinned when the project hasn't pinned the Agentur. */
    latestVersion: z.int().min(1).nullable(),
  })
  .meta({ id: "PlacementAgenturChoice" });
export type PlacementAgenturChoice = z.infer<typeof PlacementAgenturChoice>;

/**
 * Every Agentur of the catalog and every one the project has pinned, in key order; the label is
 * the pinned version's, else the latest catalog version's. A free key stays possible besides.
 */
export function placementAgenturChoices(
  catalog: readonly (TemplateRef & { label: Label })[],
  pins: readonly (TemplateRef & { label: Label })[],
): PlacementAgenturChoice[] {
  const keys = [...new Set([...catalog, ...pins].map((t) => t.agenturKey))].toSorted();
  return keys.map((agenturKey) => {
    const pin = pins.find((p) => p.agenturKey === agenturKey);
    const latest = catalog
      .filter((t) => t.agenturKey === agenturKey)
      .toSorted((a, b) => a.version - b.version)
      .at(-1);
    return {
      agenturKey,
      label: (pin ?? latest)!.label,
      pinnedVersion: pin?.version ?? null,
      latestVersion: latest?.version ?? null,
    };
  });
}
