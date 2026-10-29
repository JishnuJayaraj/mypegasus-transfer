import { z } from "zod";
import { BatchStaleRow } from "./asu/batches";
import { OrgRole, ProjectRole } from "./enums";
import { OrgRoleGrant } from "./staff/accounts";

/**
 * A staff user as a session carries it (`GET /api/v1/me`): whether they may create projects and
 * their org roles (Q126); their project roles and assignments are loaded per request.
 */
export const StaffUser = z
  .object({
    id: z.uuid(),
    displayName: z.string(),
    mayCreateProjects: z.boolean(),
    orgRoles: z.array(OrgRoleGrant),
  })
  .meta({ id: "StaffUser" });

export type StaffUser = z.infer<typeof StaffUser>;

/** A synthetic user of the dev switcher, with the role it is best known by (`staffRoleLabel`). */
export const DevStaffUser = z
  .object({
    id: z.uuid(),
    displayName: z.string(),
    role: z.union([OrgRole, ProjectRole]).nullable(),
  })
  .meta({ id: "DevStaffUser" });

export type DevStaffUser = z.infer<typeof DevStaffUser>;

/** `GET /api/v1/me`: the staff user and when the session ends (8 hours absolute, D2). */
export const CurrentStaffUser = StaffUser.extend({
  sessionExpiresAt: z.iso.datetime().meta({ description: "ISO 8601 UTC; no sliding window" }),
}).meta({ id: "CurrentStaffUser" });

export type CurrentStaffUser = z.infer<typeof CurrentStaffUser>;

/** Cursor pagination (ADR-0010). The cursor is opaque to clients. */
export const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional().meta({ description: "Opaque cursor from `nextCursor`." }),
});

export type PageQuery = z.infer<typeof PageQuery>;

export function page<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable() });
}

/** RFC 9457 problem details with an `errors` extension. Never carries submitted values. */
export const ProblemDetails = z
  .object({
    type: z.string(),
    title: z.string(),
    status: z.number().int(),
    detail: z.string().optional(),
    instance: z.string().optional(),
    /**
     * The participation a refusal refers to, where the viewer may open it (a manual creation's
     * existing Personalnummer, R32); an id, never a value.
     */
    participationId: z.uuid().optional(),
    /** A stale Kug 200b batch's rows (`batch_stale`): ids and codes, never a value. */
    staleRows: z.array(BatchStaleRow).optional(),
    errors: z
      .array(
        z.object({
          pointer: z.string().optional().meta({ description: "JSON pointer into the body" }),
          parameter: z.string().optional().meta({ description: "Query or path parameter" }),
          code: z.string(),
          detail: z.string(),
        }),
      )
      .optional(),
  })
  .meta({ id: "ProblemDetails" });

export type ProblemDetails = z.infer<typeof ProblemDetails>;
