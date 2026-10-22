import { z } from "zod";
import type { CompletenessFacts } from "../completeness/engine";
import type { RulesByStep } from "../completeness/rules";
import type { ProjectType } from "../project";
import { selfServiceMissing, wizardDocumentTypes, wizardPages } from "../self-service/wizard";

/**
 * What the participant still has to do in the portal (process-and-lifecycle.md, participant
 * actions): a field to fill in, or a document of their own types to add (`missing`) or to replace
 * (`rejected`). Codes only, never a value.
 */
export const ParticipantAction = z
  .strictObject({
    kind: z.enum(["field", "document"]),
    key: z.string(),
    state: z.enum(["missing", "rejected"]),
  })
  .meta({ id: "ParticipantAction" });
export type ParticipantAction = z.infer<typeof ParticipantAction>;

export type ActionFacts = {
  projectType: ProjectType;
  /** The participation's own resolved rules (relaxed ones removed). */
  rules: RulesByStep;
  fields: CompletenessFacts["fields"];
  /** The live documents' states by type. */
  documents: CompletenessFacts["documents"];
  /** The chain's confidential custom fields, which the wizard's last page asks for. */
  customFieldKeys: readonly string[];
};

const pageFields: ReadonlySet<string> = new Set(wizardPages.flatMap((page) => page.fields));

/**
 * One action per missing field on a wizard page that the viewer may know about (`knows`, the
 * "Selbstauskunft" tab's rule), then one per document type of the participant's own types in
 * catalog order: `missing` without a live document a rule needs; `rejected` when every live
 * document of the type is rejected, so a rejected required type is never also missing. A type
 * whose upload waits for its review asks nothing of the participant.
 */
export function participantActions(
  facts: ActionFacts,
  knows: (key: string) => boolean,
): ParticipantAction[] {
  const missing = selfServiceMissing(facts);
  const custom = new Set(facts.customFieldKeys);
  const fieldKeys = new Set(
    missing
      .filter((item) => item.kind === "field")
      .map((item) => item.key)
      .filter((key) => (pageFields.has(key) || custom.has(key)) && knows(key)),
  );
  const missingTypes = new Set(
    missing
      .filter((item) => item.kind === "document" && item.reason === "missing")
      .map((item) => item.key),
  );
  const documents = wizardDocumentTypes.flatMap((type): ParticipantAction[] => {
    const states = facts.documents[type] ?? [];
    if (missingTypes.has(type)) return [{ kind: "document", key: type, state: "missing" }];
    if (states.length > 0 && states.every((state) => state === "rejected")) {
      return [{ kind: "document", key: type, state: "rejected" }];
    }
    return [];
  });
  return [
    ...[...fieldKeys].map((key): ParticipantAction => ({ kind: "field", key, state: "missing" })),
    ...documents,
  ];
}
