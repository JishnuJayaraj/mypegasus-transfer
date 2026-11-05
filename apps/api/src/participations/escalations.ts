import type { Clock } from "@transfer/adapters";
import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  participation,
  profilingExceptionRequest,
  project,
  projectEntryWave,
  projectMembership,
  sql,
  staffUser,
  type Database,
} from "@transfer/db";
import {
  escalationRows,
  maySeeEscalations,
  participationEscalations,
  seesEscalations,
  type EntryWave,
  type Escalation,
  type EscalationRow,
  type StaffUser,
} from "@transfer/domain";
import { staffSubjectOf } from "../access";
import type { GuardFactsProvider } from "./guard-facts";
import { exceptionOf } from "./status-service";
import { attemptsOf } from "./tl407-submissions";
import { eachOf } from "./worklist";

// The regional view of escalations (data-protection.md, the regional view; Q57): for a regional
// admin the `ta_tg` projects of their regions, for a global admin every one; per project its active
// PLs and, per type, the count of escalated participations and the days overdue of the oldest. One
// read-only snapshot; only the open participations a rule applies to are read (`informed`,
// `active_in_tg`), and nothing of a participant leaves this function but its escalations' types
// and dates, which `escalationRows` turns into counts.

export type EscalationDeps = { db: Database; clock: Clock; facts: GuardFactsProvider };

export type EscalationResult =
  | { kind: "forbidden" }
  | { kind: "ok"; generatedAt: string; rows: EscalationRow[] };

export async function loadEscalations(
  { db, clock, facts }: EscalationDeps,
  user: StaffUser,
): Promise<EscalationResult> {
  const subject = await staffSubjectOf(db, user);
  if (!seesEscalations(subject)) return { kind: "forbidden" };
  const today = clock.today();
  const now = clock.now();
  return db.transaction(
    async (tx) => {
      const projects = (
        await tx
          .select({ id: project.id, name: project.name, regionId: project.regionId })
          .from(project)
          .where(eq(project.type, "ta_tg"))
          .orderBy(asc(project.id))
      ).filter((p) => maySeeEscalations(subject, p));
      const projectIds = projects.map((p) => p.id);
      if (projectIds.length === 0)
        return { kind: "ok" as const, generatedAt: now.toISOString(), rows: [] };
      const rows = await tx
        .select({
          id: participation.id,
          projectId: participation.projectId,
          entryWaveId: participation.entryWaveId,
          status: participation.status,
          profilingStatus: participation.profilingStatus,
          dsvStatus: participation.dsvStatus,
          tgStart: participation.tgStart,
          tgEnd: participation.tgEnd,
          offerDeadline: participation.offerDeadline,
          tgEntryDate: participation.tgEntryDate,
          requestId: participation.profilingExceptionRequestId,
        })
        .from(participation)
        .where(
          and(
            inArray(participation.projectId, projectIds),
            inArray(participation.status, ["informed", "active_in_tg"]),
          ),
        )
        .orderBy(asc(participation.id));
      const waves: (EntryWave & { projectId: string })[] = await tx
        .select({
          projectId: projectEntryWave.projectId,
          id: projectEntryWave.id,
          code: projectEntryWave.code,
          signingDeadline: projectEntryWave.signingDeadline,
          defaultTgStart: projectEntryWave.defaultTgStart,
          defaultTgEnd: projectEntryWave.defaultTgEnd,
          latestEntryDate: projectEntryWave.latestEntryDate,
        })
        .from(projectEntryWave)
        .where(inArray(projectEntryWave.projectId, projectIds));
      const leads = await tx
        .select({ projectId: projectMembership.projectId, name: staffUser.displayName })
        .from(projectMembership)
        .innerJoin(staffUser, eq(staffUser.id, projectMembership.staffUserId))
        .where(
          and(
            inArray(projectMembership.projectId, projectIds),
            eq(projectMembership.role, "project_lead"),
            isNull(staffUser.deactivatedAt),
          ),
        );
      const ids = rows.map((r) => r.id);
      const requestIds = rows.flatMap((r) => r.requestId ?? []);
      const requests = requestIds.length
        ? await tx
            .select()
            .from(profilingExceptionRequest)
            .where(inArray(profilingExceptionRequest.id, requestIds))
        : [];
      const inputs = rows.map((r) => ({
        participationId: r.id,
        currentRequest: exceptionOf(requests.find((q) => q.id === r.requestId)),
      }));
      const dated = facts.many ? await facts.many(tx, inputs) : await eachOf(tx, facts, inputs);
      const attempts = await attemptsOf(tx, ids);
      const declinedIds = rows
        .filter((r) => r.status === "active_in_tg" && r.profilingStatus === "profiling_declined")
        .map((r) => r.id);
      const declined = new Map<string, string>();
      if (declinedIds.length > 0) {
        const { rows: dates } = await tx.execute<{ participation_id: string; declined_on: string }>(
          sql`select participation_id, declined_on::text from profiling_declined_dates(${`{${declinedIds.join(",")}}`}::uuid[])`,
        );
        for (const d of dates) declined.set(d.participation_id, d.declined_on);
      }
      const escalations = new Map<string, Escalation[][]>(projectIds.map((id) => [id, []]));
      rows.forEach((r, index) => {
        const projectWaves = waves.filter((w) => w.projectId === r.projectId);
        const each = participationEscalations(
          {
            current: {
              status: r.status,
              profilingStatus: r.profilingStatus,
              dsvStatus: r.dsvStatus,
            },
            wave: projectWaves.find((w) => w.id === r.entryWaveId) ?? null,
            participation: {
              tgStart: r.tgStart,
              tgEnd: r.tgEnd,
              offerDeadline: r.offerDeadline,
              tgEntryDate: r.tgEntryDate,
            },
            facts: dated[index]!,
          },
          { type: "ta_tg", waves: projectWaves },
          attempts.get(r.id)!,
          declined.get(r.id) ?? null,
          today,
        );
        if (each.length > 0) escalations.get(r.projectId)!.push(each);
      });
      return {
        kind: "ok" as const,
        generatedAt: now.toISOString(),
        rows: escalationRows(
          projects.map((p) => ({
            projectId: p.id,
            projectName: p.name,
            leads: leads.filter((l) => l.projectId === p.id).map((l) => l.name),
            participations: escalations.get(p.id)!,
          })),
          today,
        ),
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
