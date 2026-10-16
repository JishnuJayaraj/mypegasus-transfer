import { isoDate } from "@transfer/domain";
import { z } from "zod";

/**
 * Job payloads (plan 5.9, ADR-0011): IDs and dates only, strict, one schema per job, so no
 * personal data or free text can travel in a job. Handlers parse before doing anything.
 */

/** The nightly sweep takes nothing: the cron sends no data. */
export const SweepPayload = z.strictObject({}).nullish();

/** A run day of the catch-up window with its originally scheduled run time (round 9). */
const RunDay = z.strictObject({
  day: isoDate,
  scheduledAt: z.iso.datetime().pipe(z.coerce.date()),
});

/** One project's evaluation for the window ending on `runDate` (the sweep's today). */
export const EvaluateProjectPayload = z
  .strictObject({
    projectId: z.uuid(),
    runDate: isoDate,
    days: z.array(RunDay).min(1),
  })
  .refine(
    ({ days, runDate }) =>
      days.at(-1)?.day === runDate && days.every((d, i) => i === 0 || days[i - 1]!.day < d.day),
    { message: "days must be ascending and end on the run date" },
  );

/** What a dispatcher sends: the serialized form (instants as ISO strings). */
export type EvaluateProjectJob = z.input<typeof EvaluateProjectPayload>;
export type EvaluateProject = z.output<typeof EvaluateProjectPayload>;
