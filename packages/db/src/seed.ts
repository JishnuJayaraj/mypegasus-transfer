import { sql } from "drizzle-orm";
import type { Database } from "./client";
import { project, projectEntryWave, projectMembership, staffUser } from "./schema";

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

/** Created through `create_project` by the seeded PL (round 23), like any other project. */
const projects = [
  {
    id: seedProjectIds.werkNord,
    name: "Restrukturierung Werk Nord",
    customerName: "Beispiel Maschinenbau GmbH",
    type: "ta_tg",
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
] as const satisfies Pick<typeof project.$inferInsert, "id" | "name" | "customerName" | "type">[];

/**
 * Memberships (D4): `create_project` makes the seeded PL a member of each seeded project; the
 * consultant and back office hold their role in every one too. Members are managed in Slice 3, so
 * these two are seed fixtures written directly. Org roles need none.
 */
export const seedMemberships = Object.values(seedProjectIds).flatMap((projectId) =>
  (
    [
      [seedStaffUserIds.consultant, "consultant"],
      [seedStaffUserIds.backOffice, "back_office"],
    ] as const
  ).map(([staffUserId, role]) => ({ projectId, staffUserId, role })),
) satisfies (typeof projectMembership.$inferInsert)[];

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
    signingDeadline: "2091-02-15",
    defaultTgStart: "2091-03-01",
    defaultTgEnd: "2092-02-29",
    latestEntryDate: "2091-03-15",
  },
  {
    id: "00000000-0000-4000-b000-000000000002",
    projectId: seedProjectIds.werkNord,
    code: "W2",
    name: "Welle 2 – lange Kündigungsfristen",
    signingDeadline: "2091-05-14",
    defaultTgStart: "2091-07-01",
    defaultTgEnd: "2092-06-30",
    latestEntryDate: "2091-07-15",
  },
] as const satisfies (typeof projectEntryWave.$inferInsert)[];

const seedWaveDates = [
  "signingDeadline",
  "defaultTgStart",
  "defaultTgEnd",
  "latestEntryDate",
] as const satisfies (keyof (typeof seedWaves)[number])[];

/** The seeded PL acting, without a request (the audit context of the setup functions). */
const asProjectLead = sql`row('user'::actor_type, ${seedStaffUserIds.projectLead}::uuid, null::uuid,
  null::text, null::uuid, null::text, null::text)::audit_context`;

/**
 * Inserts the synthetic staff users, projects, memberships and waves; existing rows are left
 * alone. Projects and waves go through their audited functions (round 23). A wave with the same
 * code (e.g. the W1 the Slice 1 migration made from the Slice 0 dates) gets the seed's dates, so
 * the participation seed finds a usable cutoff.
 */
export async function seed(db: Database): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.insert(staffUser).values(staffUsers).onConflictDoNothing();
    // Through the audited creation function, so every seeded project has `project_created`.
    const existing = new Set((await tx.select({ id: project.id }).from(project)).map((p) => p.id));
    for (const p of projects.filter(({ id }) => !existing.has(id))) {
      await tx.execute(
        sql`select create_project(p_name => ${p.name}, p_customer_name => ${p.customerName},
          p_type => ${p.type}::project_type, p_id => ${p.id}::uuid, p_context => ${asProjectLead})`,
      );
    }
    await tx.insert(projectMembership).values(seedMemberships).onConflictDoNothing();
    const waves = await tx.select().from(projectEntryWave);
    for (const wave of seedWaves) {
      const found = waves.find((w) => w.projectId === wave.projectId && w.code === wave.code);
      const dates = sql`p_signing_deadline => ${wave.signingDeadline}::date,
        p_default_tg_start => ${wave.defaultTgStart}::date,
        p_default_tg_end => ${wave.defaultTgEnd}::date,
        p_latest_entry_date => ${wave.latestEntryDate}::date, p_context => ${asProjectLead}`;
      if (!found) {
        await tx.execute(sql`select create_entry_wave(p_project_id => ${wave.projectId}::uuid,
          p_code => ${wave.code}, p_name => ${wave.name}, p_id => ${wave.id}::uuid, ${dates})`);
      } else if (seedWaveDates.some((key) => found[key] !== wave[key])) {
        await tx.execute(sql`select update_entry_wave(p_project_id => ${wave.projectId}::uuid,
          p_id => ${found.id}::uuid, p_code => ${found.code}, p_name => ${found.name}, ${dates})`);
      }
    }
  });
}
