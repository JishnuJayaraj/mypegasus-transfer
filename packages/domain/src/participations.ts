import { z } from "zod";
import { page } from "./api";
import { DsvStatus, MainStatus, ProfilingStatus } from "./lifecycle/enums";

/**
 * A participation in the project's list (Slice 2 plan 5.12, R19). Only fields the viewer may
 * `list` (decideAccess, the field catalog's `listable`) carry a value; the person fields are
 * absent for a viewer who may not list them. Paged by `(created_at, id)`, never by a name or a
 * Personalnummer.
 */
export const ParticipationListItem = z
  .strictObject({
    id: z.uuid(),
    status: MainStatus,
    profilingStatus: ProfilingStatus,
    dsvStatus: DsvStatus,
    entryWaveId: z.uuid().nullable(),
    personnelNumber: z.string().optional(),
    lastName: z.string().optional(),
    firstName: z.string().optional(),
  })
  .meta({ id: "ParticipationListItem" });
export type ParticipationListItem = z.infer<typeof ParticipationListItem>;

export const ParticipationPage = page(ParticipationListItem).meta({ id: "ParticipationPage" });
