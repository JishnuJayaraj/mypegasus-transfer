import { z } from "zod";
import { StaffRole } from "./enums";

/** The current staff user (`GET /api/v1/me`) and the dev user switcher. */
export const StaffUser = z
  .object({ id: z.uuid(), displayName: z.string(), role: StaffRole })
  .meta({ id: "StaffUser" });

export type StaffUser = z.infer<typeof StaffUser>;

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
