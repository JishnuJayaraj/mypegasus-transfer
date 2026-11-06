import { z } from "zod";
import { AppointmentKind } from "../appointments/model";
import { DocumentType } from "../documents/catalog";
import {
  SelfServicePage,
  selfServiceMissing,
  selfServiceWizard,
  wizardDocumentTypes,
  type WizardInput,
} from "../self-service/wizard";

// The portal home's progress (data-protection.md, self-service: "Das fehlt noch"). It counts the
// participant's tasks, never fields: the purposes notice, each wizard page with a required field,
// each required upload of the participant's own document types, and each appointment they were
// invited to. A page without a required field is "Freiwillig": listed, never counted. Computed
// from the completeness engine and presence flags; the response carries no value at all.

export const PortalTask = z
  .discriminatedUnion("kind", [
    /** The self-service purposes notice, before the first page (Q138). */
    z.strictObject({ kind: z.literal("notice"), done: z.boolean() }),
    /** A wizard page with at least one required field; done when none of them is missing. */
    z.strictObject({ kind: z.literal("section"), page: SelfServicePage, done: z.boolean() }),
    /** A required upload of one of the participant's own document types. */
    z.strictObject({ kind: z.literal("upload"), documentType: DocumentType, done: z.boolean() }),
    /** An invitation to an upcoming appointment; done with a booking of it. */
    z.strictObject({
      kind: z.literal("appointment"),
      appointmentId: z.uuid(),
      appointmentKind: AppointmentKind,
      done: z.boolean(),
    }),
  ])
  .meta({ id: "PortalTask" });
export type PortalTask = z.infer<typeof PortalTask>;

/** `GET /portal/progress`: tasks with a done flag and the optional pages; never a value. */
export const PortalProgress = z
  .strictObject({
    tasks: z.array(PortalTask),
    /** "Freiwillig": wizard pages without a required item. They never count. */
    optional: z.array(SelfServicePage),
  })
  .meta({ id: "PortalProgress" });
export type PortalProgress = z.infer<typeof PortalProgress>;

/** An appointment the participant was invited to, with whether they hold a booking of it. */
export type PortalInvitationFact = {
  appointmentId: string;
  kind: AppointmentKind;
  booked: boolean;
};

export type PortalProgressInput = {
  wizard: WizardInput;
  noticeAcknowledged: boolean;
  /** The invitations that still count: booked ones, and open ones not yet started or cancelled. */
  invitations: readonly PortalInvitationFact[];
};

const ownTypes = new Set<string>(wizardDocumentTypes);

/** The participant's tasks in a fixed order (notice, pages, uploads, appointments) and the optional pages. */
export function portalProgress(input: PortalProgressInput): PortalProgress {
  const { pages, missing } = selfServiceWizard(input.wizard);
  const missingKeys = new Set(missing.map((item) => item.key));
  // The uploads the rules require now: the document items with no document present at all.
  const requiredUploads = [
    ...new Set(
      selfServiceMissing({ ...input.wizard, documents: {} })
        .filter((item) => item.kind === "document" && ownTypes.has(item.key))
        .map((item) => item.key as DocumentType),
    ),
  ];

  const sections: PortalTask[] = [];
  const optional: SelfServicePage[] = [];
  for (const page of pages) {
    if (page.page === "documents") {
      if (requiredUploads.length === 0) optional.push(page.page);
    } else if (page.fields.some((field) => field.required)) {
      sections.push({ kind: "section", page: page.page, done: page.complete });
    } else {
      optional.push(page.page);
    }
  }
  return {
    tasks: [
      { kind: "notice", done: input.noticeAcknowledged },
      ...sections,
      ...requiredUploads.map((documentType): PortalTask => ({
        kind: "upload",
        documentType,
        done: !missingKeys.has(documentType),
      })),
      ...input.invitations.map((invitation): PortalTask => ({
        kind: "appointment",
        appointmentId: invitation.appointmentId,
        appointmentKind: invitation.kind,
        done: invitation.booked,
      })),
    ],
    optional,
  };
}

/** Done tasks and all tasks; the optional pages are not tasks, so they never change it. */
export function progressCount(progress: Pick<PortalProgress, "tasks">) {
  return {
    done: progress.tasks.filter((task) => task.done).length,
    total: progress.tasks.length,
  };
}
