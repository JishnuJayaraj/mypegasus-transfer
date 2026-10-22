import { isoDate } from "@transfer/domain";
import { z } from "zod";

/**
 * Job payloads (plan 5.9, ADR-0011): IDs and dates only, strict, one schema per job, so no
 * personal data or free text can travel in a job. Handlers parse before doing anything.
 */

/** The nightly sweep takes nothing: the cron sends no data. */
export const SweepPayload = z.strictObject({}).nullish();

/**
 * One project's evaluation of the window `firstDay` … `runDate` (the sweep's today). Only the
 * bounds travel (round 21): the job derives the contiguous days and their scheduled instants
 * from `JOBS_LIFECYCLE_TIME` and checks `firstDay` against `job_run` itself.
 */
export const EvaluateProjectPayload = z
  .strictObject({ projectId: z.uuid(), firstDay: isoDate, runDate: isoDate })
  .refine(({ firstDay, runDate }) => firstDay <= runDate, {
    message: "firstDay must not be after runDate",
  });

export type EvaluateProject = z.infer<typeof EvaluateProjectPayload>;

/** The activation notice of one channel (D21): its id only; the job reads the rest. */
export const ActivationNoticePayload = z.strictObject({ channelId: z.uuid() });

/** A deleted document's purge: its id only; the job reads the rest. */
export const PurgeDocumentPayload = z.strictObject({ documentId: z.uuid() });
