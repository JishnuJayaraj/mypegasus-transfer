import { seedStaffUserIds, sql, type Database } from "@transfer/db";
import { auditContext, callFunction } from "../sql";
import { seedParticipationIds } from "./seed";

/**
 * Synthetic identities for the seeded participations (Slice 2 plan 5.14, PR 2f): placeholder names,
 * Personalnummern `BSP-0001…`, `Musterstraße` in `99999 Beispielstadt` and emails at
 * `example.org`, never a real person (D8). Written by the PL through `write_participant_data`, so
 * each has its audit event; idempotent, since an unchanged write writes nothing.
 */
const lastNames = ["Mustermann", "Musterfrau", "Beispiel", "Normalverbraucher", "Muster", "Probe"];
const firstNames = ["Erika", "Max", "Anna", "Paul", "Lena", "Jonas"];

export const seedIdentities = Object.values(seedParticipationIds).map((participationId, i) => {
  const n = String(i + 1).padStart(4, "0");
  return {
    participationId,
    personnelNumber: `BSP-${n}`,
    lastName: lastNames[i % lastNames.length]!,
    firstName: firstNames[Math.floor(i / lastNames.length) % firstNames.length]!,
    addressStreet: `Musterstraße ${i + 1}`,
    addressPostalCode: "99999",
    addressCity: "Beispielstadt",
    addressCountry: "DE",
    privateEmail: `teilnehmer-${n}@example.org`,
  };
});

/** Writes the seed identities; returns how many writes changed something. */
export async function seedParticipantData(db: Database): Promise<number> {
  const context = auditContext(seedStaffUserIds.projectLead, null);
  let written = 0;
  for (const p of seedIdentities) {
    const event = await callFunction(
      db,
      sql`write_participant_data(p_participation_id => ${p.participationId}::uuid,
        p_context => ${context}, p_personnel_number => ${p.personnelNumber},
        p_last_name => ${p.lastName}, p_first_name => ${p.firstName},
        p_address_street => ${p.addressStreet}, p_address_postal_code => ${p.addressPostalCode},
        p_address_city => ${p.addressCity}, p_address_country => ${p.addressCountry},
        p_private_email => ${p.privateEmail})`,
    );
    if (event !== null) written += 1;
  }
  return written;
}
