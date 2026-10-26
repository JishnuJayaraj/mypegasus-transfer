import { decideAccess, type Subject } from "../access/decide";
import {
  staffPermission,
  type Actor,
  type Permission,
  type PermissionTarget,
} from "../access/permissions";

// Who works with the profiling record (data-protection.md, access matrix and the profiling
// record; Q49, Q60, Q62, Q193). The tab "Profiling" is the PL's and the assigned consultant's
// (back office has none); the sessions, the pending declarations and the unemployment period are
// recorded by the assigned consultant; section C and p. 7 only the assigned consultant reads and
// writes. The track's own changes are the lifecycle edges' (`mayPerformTransition`). Normal mode
// only: assisted mode and break-glass grant none of it (the routes take neither).

const denied = { ok: false, because: "actor_not_allowed" } as const satisfies Permission;

/** The tab: the PL of the project, or the consultant currently assigned (Q62). */
export function mayViewProfiling(actor: Actor, target: PermissionTarget): Permission {
  if (actor.kind !== "staff") return denied;
  return staffPermission(actor, target, (role) => role === "project_lead" || role === "consultant");
}

/**
 * Recording the sessions, the pending declarations to the BA and the unemployment period
 * (data-protection.md, the profiling record; Q193): the assigned consultant only, as a domain
 * operation; the PL reads the sessions.
 */
export function mayRecordProfiling(actor: Actor, target: PermissionTarget): Permission {
  if (actor.kind !== "staff") return denied;
  return staffPermission(actor, target, (role) => role === "consultant");
}

/**
 * Reading and writing section C and p. 7 (data-protection.md, access matrix: the assigned
 * consultant only, Q49; a PL who is also a consultant only for the participations assigned to
 * them, Q61), as the matrix decides for its fields in normal mode.
 */
export function mayUseProfilingAssessment(
  subject: Subject,
  target: PermissionTarget,
  action: "read" | "write",
): boolean {
  return (
    decideAccess(
      subject,
      {
        kind: "field",
        field: "profilingAssessment",
        projectId: target.projectId,
        regionId: target.regionId,
        participationId: target.participationId,
        phase: "active",
      },
      action,
      { kind: "normal" },
    ).effect === "allow"
  );
}

/**
 * Reading the unemployment period: like the other residence and social answers (the assigned
 * consultant, back office), a logged read; never the PL (data-protection.md, access matrix; Q85).
 */
export function mayReadUnemploymentPeriod(subject: Subject, target: PermissionTarget): boolean {
  return (
    decideAccess(
      subject,
      {
        kind: "field",
        field: "unemploymentPeriod",
        projectId: target.projectId,
        regionId: target.regionId,
        participationId: target.participationId,
        phase: "active",
      },
      "read",
      { kind: "normal" },
    ).effect === "allow"
  );
}
