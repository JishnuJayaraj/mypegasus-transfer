import { z } from "zod";
import { decideAccess, type AccessAction, type AccessMode, type Subject } from "../access/decide";
import type { MissingItem } from "../completeness/engine";
import type { DocumentType } from "../documents/catalog";
import { sensitiveFields, type SensitiveField } from "./sensitive";
import type { WizardPage } from "./wizard";

// Assisted mode (ADR-0007, assisted mode; Q136) and the staff view of self-service data
// (data-protection.md, self-service). Staff open the participant's wizard after confirming the
// person is present or on the phone and asked for help; they see and write exactly what the access
// matrix gives their role in mode `assisted`, and a field they can't see is hidden, never shown
// empty. Pure: the API loads the subject and the record, the database functions check again.

/** How the participant takes part: in person or on the phone (Q136); no free text. */
export const AssistedModeHow = z.enum(["in_person", "phone"]).meta({ id: "AssistedModeHow" });
export type AssistedModeHow = z.infer<typeof AssistedModeHow>;

/** "Beenden", or the staff session it is bound to ended (it has no expiry of its own). */
export const AssistedModeEndReason = z.enum(["ended", "staff_session_ended"]);
export type AssistedModeEndReason = z.infer<typeof AssistedModeEndReason>;

/**
 * `POST /participations/{id}/assisted-mode`: the confirmation "Die Person ist anwesend oder am
 * Telefon und hat um Unterstützung gebeten" and how.
 */
export const StartAssistedModeInput = z
  .strictObject({ confirmed: z.literal(true), how: AssistedModeHow })
  .meta({ id: "StartAssistedModeInput" });
export type StartAssistedModeInput = z.infer<typeof StartAssistedModeInput>;

/** A live assisted mode of the staff session; every assisted request names its id. */
export const AssistedModeView = z
  .strictObject({
    assistedModeId: z.uuid(),
    participationId: z.uuid(),
    how: AssistedModeHow,
    startedAt: z.iso.datetime().meta({ description: "UTC timestamp (ISO 8601)" }),
  })
  .meta({ id: "AssistedMode" });
export type AssistedModeView = z.infer<typeof AssistedModeView>;

/** The query every assisted route takes (`403 assisted_mode_required` without a live one). */
export const AssistedModeQuery = z.object({ assistedModeId: z.uuid() });

/** The participation the access is decided for, in its project and region. */
export type AccessTarget = { projectId: string; regionId: string | null; participationId: string };

/**
 * A wizard key as the matrix knows it: a custom field is confidential at most and answered by the
 * participant (regional-variation.md, custom fields), so it is decided as a confidential
 * self-service field of the profile.
 */
export const matrixField = (key: string) => (key.startsWith("custom.") ? "gender" : key);

function allows(
  subject: Subject,
  target: AccessTarget,
  key: string,
  action: AccessAction,
  mode: AccessMode,
) {
  const resource = { kind: "field", ...target, phase: "active", field: matrixField(key) } as const;
  return decideAccess(subject, resource, action, mode).effect === "allow";
}

const assisted = (target: AccessTarget): AccessMode => ({
  kind: "assisted",
  onBehalfOf: target.participationId,
});

/**
 * Whether the subject sees and writes a wizard field in assisted mode (Q136): both, or the field
 * is hidden. The PL: confidential, health and disability; the assigned consultant: every field;
 * back office: all but health; an unassigned consultant: none.
 */
export function assistedFieldAccess(subject: Subject, target: AccessTarget) {
  const mode = assisted(target);
  return (key: string) =>
    allows(subject, target, key, "read", mode) && allows(subject, target, key, "write", mode);
}

/**
 * The staff view in normal mode (data-protection.md, self-service, the "Selbstauskunft" tab):
 * `reads` a value without assisted mode (a sensitive one as a logged read); `knows` whether it is
 * given and missing, which a role that sees the field in assisted mode or with break-glass does
 * too (the PL: health and disability, presence only).
 */
export function staffSelfServiceAccess(subject: Subject, target: AccessTarget) {
  const normal: AccessMode = { kind: "normal" };
  const reads = (key: string) => allows(subject, target, key, "read", normal);
  return {
    reads,
    knows: (key: string) => reads(key) || allows(subject, target, key, "read", assisted(target)),
  };
}

/** The sensitive fields a predicate admits, in wizard order. */
export const sensitiveFieldsWhere = (admits: (key: string) => boolean): SensitiveField[] =>
  sensitiveFields.filter(admits);

/**
 * The wizard as a viewer may see it: fields they can't see are left out (a page left without
 * fields too), and so are their missing items; a page is complete when none of its shown fields
 * is missing. "Unterlagen" keeps the document types the viewer reads in the mode (`documentTypes`),
 * and is left out without any.
 */
export function restrictWizard(
  wizard: { pages: readonly WizardPage[]; missing: readonly MissingItem[] },
  visible: (key: string) => boolean,
  documentTypes: readonly DocumentType[],
): { pages: WizardPage[]; missing: MissingItem[] } {
  const readable = new Set<string>(documentTypes);
  const missing = wizard.missing.filter((item) =>
    item.kind === "document" ? readable.has(item.key) : visible(item.key),
  );
  const missingKeys = new Set(missing.map((item) => item.key));
  const pages = wizard.pages.flatMap((page) => {
    if (page.documentTypes) {
      const types = page.documentTypes.filter((type) => readable.has(type));
      const complete = types.every((type) => !missingKeys.has(type));
      return types.length > 0 ? [{ ...page, complete, documentTypes: types }] : [];
    }
    const fields = page.fields.filter((field) => visible(field.key));
    const complete = fields.every((field) => !missingKeys.has(field.key));
    return fields.length > 0 ? [{ ...page, fields, complete }] : [];
  });
  return { pages, missing };
}
