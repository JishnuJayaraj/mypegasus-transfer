import { z } from "zod";
import { isoDate } from "../iso-date";
import { AuditEventType, StatusField } from "./events";
import { historyEventTypes } from "./history";

// `GET /participations/{id}/history` (ADR-0010; data-protection.md, audit metadata; Q157): the
// projection `audit_history` returned, localized by the client. Codes, ids, dates and the actor's
// current name only.

export const HistoryEventType = AuditEventType.extract(
  historyEventTypes as [AuditEventType, ...AuditEventType[]],
).meta({ id: "HistoryEventType" });
export type HistoryEventType = z.infer<typeof HistoryEventType>;

/** Who acted: a staff member by their current name (`null` once it isn't retained), or the kind. */
export const HistoryActor = z
  .strictObject({
    kind: z.enum(["staff", "participant", "system"]),
    name: z.string().nullable(),
    /** Staff acting in assisted mode on the participant's behalf. */
    assisted: z.boolean(),
    /** The job of a system actor. */
    job: z.string().nullable(),
  })
  .meta({ id: "HistoryActor" });
export type HistoryActor = z.infer<typeof HistoryActor>;

/**
 * A status change (`field`), a creation (to `imported`) or an end-reason correction (no field).
 * No schema id: it is only used nullable (an id would make the generated type nullable everywhere).
 */
export const HistoryChange = z.strictObject({
  field: StatusField.nullable(),
  from: z.string().nullable(),
  to: z.string(),
});

/** A shown detail: a code, a date, an id, a flag (`afterClose`, `statusChanged`) or codes. */
const HistoryDetail = z.union([z.string(), z.boolean(), z.array(z.string())]).nullable();

export const HistoryEntry = z
  .strictObject({
    occurredAt: z.iso.datetime().meta({ description: "UTC timestamp (ISO 8601)" }),
    type: HistoryEventType,
    actor: HistoryActor,
    change: HistoryChange.nullable(),
    reasonCode: z.string().nullable(),
    effectiveDate: isoDate.nullable(),
    details: z.record(z.string(), HistoryDetail),
  })
  .meta({ id: "HistoryEntry" });
export type HistoryEntry = z.infer<typeof HistoryEntry>;

/** Newest first; `nextCursor` is opaque. */
export const HistoryPage = z
  .strictObject({ items: z.array(HistoryEntry), nextCursor: z.string().nullable() })
  .meta({ id: "HistoryPage" });
export type HistoryPage = z.infer<typeof HistoryPage>;
