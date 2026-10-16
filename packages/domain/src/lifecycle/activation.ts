import type { ProjectType } from "../project";
import type { EntryWave } from "./waves";

export type ProjectActivationBlocker =
  | "project_activation_blocked"
  | "no_entry_wave_with_latest_entry_date";

/**
 * Why a project can't be activated yet; activation itself is Slice 2. The resolved project
 * configuration blocks without a KuG-Agentur template (Q76, for every project type until Q90
 * is answered), and a `ta_tg` project needs at least one entry wave with a `latestEntryDate`
 * (Q77). Other configuration blockers (Agentur submission) don't block activation.
 */
export function projectActivationBlockers(
  project: { type: ProjectType },
  waves: readonly Pick<EntryWave, "latestEntryDate">[],
  resolution: { blockers: readonly { code: string }[] },
): ProjectActivationBlocker[] {
  const blockers: ProjectActivationBlocker[] = [];
  if (resolution.blockers.some((blocker) => blocker.code === "project_activation_blocked")) {
    blockers.push("project_activation_blocked");
  }
  if (project.type === "ta_tg" && !waves.some((wave) => wave.latestEntryDate !== null)) {
    blockers.push("no_entry_wave_with_latest_entry_date");
  }
  return blockers;
}
