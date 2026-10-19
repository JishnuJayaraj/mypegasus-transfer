import { z } from "zod";
import { page } from "./api";
import { isoDate } from "./iso-date";
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

/** Hints derived for the detail, never stored (plan 5.13; like the planner's flags). */
export const ParticipationHint = z.enum(["tg_start_missed"]);
export type ParticipationHint = z.infer<typeof ParticipationHint>;

/** Street with house number, postal code, city and country: one unit (round 32). */
export const ParticipantAddress = z
  .strictObject({
    street: z.string(),
    postalCode: z.string(),
    city: z.string(),
    country: z.string(),
  })
  .meta({ id: "ParticipantAddress" });
export type ParticipantAddress = z.infer<typeof ParticipantAddress>;

const recorded = <T extends z.ZodType>(schema: T) => schema.nullable().optional();

/**
 * One participation for its detail page (Slice 2 plan, "Planned in PR 2h", R30, R31; AC-34). The
 * case data (statuses, wave, dates) is shown only to a viewer who may read all of it; each person
 * field is absent where the viewer may not read it and `null` where nothing is recorded. The
 * capabilities are derived by the server; the routes decide again.
 */
export const ParticipationDetail = z
  .strictObject({
    id: z.uuid(),
    projectId: z.uuid(),
    status: MainStatus,
    profilingStatus: ProfilingStatus,
    dsvStatus: DsvStatus,
    /** The version a status-dependent write compares (compare-and-set). */
    statusVersion: z.int().min(0),
    entryWave: z
      .strictObject({
        id: z.uuid(),
        code: z.string(),
        name: z.string(),
        signingDeadline: isoDate.nullable(),
        defaultTgStart: isoDate.nullable(),
        defaultTgEnd: isoDate.nullable(),
        latestEntryDate: isoDate.nullable(),
      })
      .nullable(),
    dates: z.strictObject({
      /** The participation's own contractual dates; `null` means the wave's applies. */
      tgStart: isoDate.nullable(),
      tgEnd: isoDate.nullable(),
      effectiveTgStart: isoDate.nullable(),
      effectiveTgEnd: isoDate.nullable(),
      offerDeadline: isoDate.nullable(),
      tgEntryDate: isoDate.nullable(),
      exitDate: isoDate.nullable(),
      withdrawnOn: isoDate.nullable(),
      profilingDoneOn: isoDate.nullable(),
    }),
    hints: z.array(ParticipationHint),
    person: z.strictObject({
      personnelNumber: recorded(z.string()),
      lastName: recorded(z.string()),
      firstName: recorded(z.string()),
      birthDate: recorded(isoDate),
      oldEmploymentEndDate: recorded(isoDate),
      address: recorded(ParticipantAddress),
      phone: recorded(z.string()),
      mobile: recorded(z.string()),
      privateEmail: recorded(z.string()),
      workEmail: recorded(z.string()),
    }),
    capabilities: z.strictObject({ assignEntryWave: z.boolean() }),
  })
  .meta({ id: "ParticipationDetail" });
export type ParticipationDetail = z.infer<typeof ParticipationDetail>;

/** `PUT /participations/{id}/entry-wave` (R33). */
export const AssignEntryWaveInput = z
  .strictObject({ waveId: z.uuid() })
  .meta({ id: "AssignEntryWaveInput" });
export type AssignEntryWaveInput = z.infer<typeof AssignEntryWaveInput>;
