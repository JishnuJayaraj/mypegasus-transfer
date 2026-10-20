import { z } from "zod";
import { ProjectRole } from "../enums";

/**
 * A project's team and the participant assignments (data-protection.md, access matrix; Q61, Q62,
 * Q126). The PL adds and removes members and their project roles and assigns participations to
 * members holding `consultant`; a global admin may add a replacement PL, never themselves.
 */

/** Participations one assignment request may name (all or nothing). */
export const assignmentLimit = 500;

/** Why a membership row ended (`project_member_removed`). */
export const MemberRemovalReason = z.enum(["member_removed", "account_deactivated"]);
export type MemberRemovalReason = z.infer<typeof MemberRemovalReason>;

/**
 * Why an assignment was closed; rows are closed, never deleted: by the PL, with the consultant
 * role, or with the account.
 */
export const AssignmentEndReason = z.enum([
  "unassigned",
  "consultant_removed",
  "account_deactivated",
]);
export type AssignmentEndReason = z.infer<typeof AssignmentEndReason>;

export const ProjectMember = z
  .strictObject({
    staffUserId: z.uuid(),
    displayName: z.string(),
    roles: z.array(ProjectRole).min(1),
    deactivated: z.boolean(),
  })
  .meta({ id: "ProjectMember" });
export type ProjectMember = z.infer<typeof ProjectMember>;

/** `GET /projects/{id}/members`: the members and what the viewer may do (capabilities). */
export const ProjectTeam = z
  .strictObject({
    members: z.array(ProjectMember),
    capabilities: z.strictObject({
      manageMembers: z.boolean(),
      /** Add a PL other than oneself (a global admin's recovery path). */
      addReplacementLead: z.boolean(),
      assignParticipations: z.boolean(),
    }),
  })
  .meta({ id: "ProjectTeam" });
export type ProjectTeam = z.infer<typeof ProjectTeam>;

export const AddMemberInput = z
  .strictObject({ staffUserId: z.uuid(), role: ProjectRole })
  .meta({ id: "AddMemberInput" });
export type AddMemberInput = z.infer<typeof AddMemberInput>;

export const AssignParticipationsInput = z
  .strictObject({
    staffUserId: z.uuid(),
    participationIds: z.array(z.uuid()).min(1).max(assignmentLimit),
  })
  .refine(({ participationIds }) => new Set(participationIds).size === participationIds.length, {
    message: "A participation is named twice",
    path: ["participationIds"],
    params: { code: "duplicate_participation" },
  })
  .meta({ id: "AssignParticipationsInput" });
export type AssignParticipationsInput = z.infer<typeof AssignParticipationsInput>;

/** The new assignments; participations already assigned to that consultant count nothing. */
export const AssignmentResult = z
  .strictObject({ assigned: z.int().min(0) })
  .meta({ id: "AssignmentResult" });
export type AssignmentResult = z.infer<typeof AssignmentResult>;

/** A consultant assigned to a participation (list column and detail). */
export const AssignedConsultant = z
  .strictObject({
    staffUserId: z.uuid(),
    displayName: z.string(),
    assignedAt: z.iso.datetime().meta({ description: "UTC timestamp (ISO 8601)" }),
  })
  .meta({ id: "AssignedConsultant" });
export type AssignedConsultant = z.infer<typeof AssignedConsultant>;
