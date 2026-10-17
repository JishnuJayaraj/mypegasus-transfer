import { seedProjectIds, seedStaffUserIds, type Database } from "@transfer/db";
import { pinTemplate, type Release } from "./template-pins";

const { werkNord, verwaltung } = seedProjectIds;

/**
 * The seed's pins (plan 5.5, 5.14), through the pin service by the seeded PL, never written
 * directly: Werk Nord's Project Agentur `beispielstadt-nord@1` plus `beispielstadt-sued@1` as a
 * placement Agentur, the `ta_only` project's `beispielstadt-sued@1`. Lager Süd stays without a
 * Project Agentur (its blockers are the demo). Idempotent: a pin that exists is skipped.
 */
const seedPins = [
  { projectId: werkNord, agenturKey: "beispielstadt-nord", version: 1, projectAgentur: true },
  { projectId: werkNord, agenturKey: "beispielstadt-sued", version: 1, projectAgentur: false },
  { projectId: verwaltung, agenturKey: "beispielstadt-sued", version: 1, projectAgentur: true },
];

const alreadyPinned = (issue: string | { code: string }) =>
  (typeof issue === "string" ? issue : issue.code) === "template_already_pinned";

export async function seedTemplatePins(db: Database, release: Release): Promise<void> {
  const actor = { staffUserId: seedStaffUserIds.projectLead, requestId: null };
  for (const { projectId, ...input } of seedPins) {
    const result = await pinTemplate(db, release, actor, projectId, input);
    if (result === true || result?.issues.every(alreadyPinned)) continue;
    throw new Error(`The seed could not pin ${input.agenturKey}@${input.version}`);
  }
}
