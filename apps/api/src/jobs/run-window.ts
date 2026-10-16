import { scheduledAt } from "@transfer/adapters";
import { sql, type Database } from "@transfer/db";
import { addDays, type IsoDate, type RunDay } from "@transfer/domain";
import { jobNames } from "./names";

/**
 * Where the lifecycle run of `runDate` stands, asked of the database (Q96, round 21): whether its
 * scheduled time has passed by database time, and the last completed run. The sweep and every
 * project job ask independently; neither trusts the other's or a caller's view.
 */
export async function lifecycleRunState(
  db: Database,
  runDate: IsoDate,
  lifecycleTime: string,
): Promise<{ due: boolean; last: IsoDate | null; firstDay: IsoDate }> {
  const at = scheduledAt(runDate, lifecycleTime).toISOString();
  const { rows } = await db.execute<{ due: boolean; last: IsoDate | null }>(sql`
    select now() >= ${at}::timestamptz as due,
      (select max(run_date)::text from job_run where job_name = ${jobNames.lifecycleSweep}) as last`);
  const { due, last } = rows[0]!;
  // The catch-up window starts after the last completed run; the first run ever covers today.
  return { due, last, firstDay: last === null ? runDate : addDays(last, 1) };
}

/**
 * The contiguous run days `firstDay` … `runDate`, each with its canonical scheduled instant
 * (`JOBS_LIFECYCLE_TIME`, Europe/Berlin), derived here rather than taken from a payload.
 */
export function runDays(firstDay: IsoDate, runDate: IsoDate, lifecycleTime: string): RunDay[] {
  const days: RunDay[] = [];
  for (let day = firstDay; day <= runDate; day = addDays(day, 1)) {
    days.push({ day, scheduledAt: scheduledAt(day, lifecycleTime) });
  }
  return days;
}
