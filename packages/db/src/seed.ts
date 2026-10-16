import type { Database } from "./client";
import { project, projectEntryWave, staffUser } from "./schema";

// Synthetic data only (CLAUDE.md rule 1): obviously fictional names, emails at example.org.
// Fixed UUIDs make the seed idempotent.

export const seedStaffUserIds = {
  admin: "00000000-0000-4000-8000-000000000001",
  regionalAdmin: "00000000-0000-4000-8000-000000000002",
  projectLead: "00000000-0000-4000-8000-000000000003",
  consultant: "00000000-0000-4000-8000-000000000004",
  backOffice: "00000000-0000-4000-8000-000000000005",
  regionalOperationsManager: "00000000-0000-4000-8000-000000000006",
} as const;

export const seedProjectIds = {
  werkNord: "00000000-0000-4000-9000-000000000001",
  lagerSued: "00000000-0000-4000-9000-000000000002",
  verwaltung: "00000000-0000-4000-9000-000000000003",
} as const;

type NewStaffUser = typeof staffUser.$inferInsert;
type NewProject = typeof project.$inferInsert;

const staffUsers: NewStaffUser[] = (
  [
    { id: seedStaffUserIds.admin, displayName: "Erika Musterfrau", role: "admin" },
    { id: seedStaffUserIds.regionalAdmin, displayName: "Rainer Regional", role: "regional_admin" },
    { id: seedStaffUserIds.projectLead, displayName: "Petra Projektleitung", role: "project_lead" },
    { id: seedStaffUserIds.consultant, displayName: "Bernd Beratung", role: "consultant" },
    { id: seedStaffUserIds.backOffice, displayName: "Birgit Backoffice", role: "back_office" },
    {
      id: seedStaffUserIds.regionalOperationsManager,
      displayName: "Rolf Regionalbetrieb",
      role: "regional_operations_manager",
    },
  ] satisfies Omit<NewStaffUser, "email">[]
).map((user) => ({ ...user, email: `${user.role.replaceAll("_", "-")}@example.org` }));

const projects: NewProject[] = (
  [
    {
      id: seedProjectIds.werkNord,
      name: "Restrukturierung Werk Nord",
      customerName: "Beispiel Maschinenbau GmbH",
      type: "ta_tg",
      signingDeadline: "2027-02-15",
      defaultTgStart: "2027-03-01",
      defaultTgEnd: "2028-02-29",
    },
    {
      id: seedProjectIds.lagerSued,
      name: "Standortschließung Lager Süd",
      customerName: "Musterfirma Logistik AG",
      type: "ta_tg",
    },
    {
      id: seedProjectIds.verwaltung,
      name: "Transferagentur Verwaltung",
      customerName: "Fiktiv Versicherungen KG",
      type: "ta_only",
    },
  ] satisfies Omit<NewProject, "createdBy">[]
).map((p) => ({ ...p, createdBy: seedStaffUserIds.projectLead }));

/**
 * Werk Nord's two entry waves (Q79, plan 5.10): W1 matches the project's Slice 0 dates, W2 is a
 * later cohort. Fictional contractual dates.
 */
export const seedWaves = [
  {
    id: "00000000-0000-4000-b000-000000000001",
    projectId: seedProjectIds.werkNord,
    code: "W1",
    name: "Welle 1 – kurze Kündigungsfristen",
    signingDeadline: "2027-02-15",
    defaultTgStart: "2027-03-01",
    defaultTgEnd: "2028-02-29",
    latestEntryDate: "2027-03-15",
  },
  {
    id: "00000000-0000-4000-b000-000000000002",
    projectId: seedProjectIds.werkNord,
    code: "W2",
    name: "Welle 2 – lange Kündigungsfristen",
    signingDeadline: "2027-05-14",
    defaultTgStart: "2027-07-01",
    defaultTgEnd: "2028-06-30",
    latestEntryDate: "2027-07-15",
  },
] as const satisfies (typeof projectEntryWave.$inferInsert)[];

/**
 * Inserts the synthetic staff users, projects and waves; existing staff users and projects are
 * left alone. A wave with the same code (e.g. the W1 the Slice 1 migration made from the Slice 0
 * dates) gets the seed's dates, so the participation seed finds a usable cutoff.
 */
export async function seed(db: Database): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.insert(staffUser).values(staffUsers).onConflictDoNothing();
    await tx.insert(project).values(projects).onConflictDoNothing();
    for (const wave of seedWaves) {
      const { id: _id, projectId: _projectId, code: _code, ...dates } = wave;
      await tx
        .insert(projectEntryWave)
        .values(wave)
        .onConflictDoUpdate({
          target: [projectEntryWave.projectId, projectEntryWave.code],
          set: dates,
        });
    }
  });
}
