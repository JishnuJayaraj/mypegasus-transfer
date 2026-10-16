import type { Database } from "./client";
import { project, staffUser } from "./schema";

// Synthetic data only (CLAUDE.md rule 1): obviously fictional names, emails at example.org.
// Fixed UUIDs make the seed idempotent.

export const seedStaffUserIds = {
  admin: "00000000-0000-4000-8000-000000000001",
  regionalAdmin: "00000000-0000-4000-8000-000000000002",
  projectLead: "00000000-0000-4000-8000-000000000003",
  consultant: "00000000-0000-4000-8000-000000000004",
  backOffice: "00000000-0000-4000-8000-000000000005",
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
  ] satisfies Omit<NewStaffUser, "email">[]
).map((user) => ({ ...user, email: `${user.role.replace("_", "-")}@example.org` }));

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

/** Inserts the synthetic staff users and projects; existing rows are left alone. */
export async function seed(db: Database): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.insert(staffUser).values(staffUsers).onConflictDoNothing();
    await tx.insert(project).values(projects).onConflictDoNothing();
  });
}
