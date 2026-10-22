import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import {
  createDb,
  participantDetails,
  participantIdentity,
  participation,
  seedStaffUserIds,
} from "@transfer/db";
import { activateAsOwner, testDatabaseUrls } from "@transfer/db/testing";
import { expect } from "./helpers";

// Participants of the portal specs, activated without the portal: every code submission of a run
// shares one client IP and its throttle (10 per 15 minutes, Q128), and activation.spec.ts spends
// five of them on the activation and the login it tests. The other specs set their participant up
// here, as the owner (a test fixture, like activateAsOwner), and spend only what they test:
// self-service.spec.ts its login (2), sensitive.spec.ts its step-up (2), assisted.spec.ts none.
// Synthetic data only.

const ok = async (response: Promise<{ ok(): boolean; status(): number }>) =>
  expect((await response).ok()).toBe(true);

/**
 * An activated participant of `projectId` (born 01.01.1970, the birth-date assurance) with a
 * verified private email `address`, as a letter's activation leaves them. The PL issues the letter
 * and, with `agenturKey`, places the participation through the staff API first; with
 * `oldEmploymentEndDate` the import brought the Austrittsdatum too.
 */
export async function activatedParticipant(
  page: Page,
  baseURL: string,
  options: {
    projectId: string;
    address: string;
    agenturKey?: string;
    oldEmploymentEndDate?: string;
  },
) {
  const { projectId, address } = options;
  const participationId = randomUUID();
  const owner = createDb(testDatabaseUrls("transfer_e2e").owner);
  try {
    await activateAsOwner(owner.$client, [projectId]);
    await owner.insert(participation).values({
      id: participationId,
      projectId,
      status: "contacted",
      profilingStatus: "not_started",
      dsvStatus: "not_offered",
    });
    await owner.insert(participantIdentity).values({
      participationId,
      projectId,
      personnelNumber: `E2E-${participationId.slice(0, 8)}`,
      firstName: "Erika",
      lastName: "Beispiel",
      birthDate: "1970-01-01",
    });
    await owner.insert(participantDetails).values({
      participationId,
      projectId,
      addressStreet: "Musterweg 1",
      addressPostalCode: "10115",
      addressCity: "Berlin",
      addressCountry: "DE",
      oldEmploymentEndDate: options.oldEmploymentEndDate ?? null,
    });

    const api = page.context().request;
    const headers = { Origin: baseURL };
    await ok(
      api.post("/api/v1/dev/session", {
        headers,
        data: { staffUserId: seedStaffUserIds.projectLead },
      }),
    );
    if (options.agenturKey) {
      await ok(
        api.put(`/api/v1/participations/${participationId}/placement-agentur`, {
          headers,
          data: { agenturKey: options.agenturKey },
        }),
      );
    }
    await ok(
      api.post(`/api/v1/projects/${projectId}/activation-codes`, {
        headers,
        data: { participationIds: [participationId], channel: "letter", language: "de" },
      }),
    );

    // What complete_activation writes: the code used, the account, the consent and the channel.
    const consentId = randomUUID();
    const channelId = randomUUID();
    await owner.$client.query(
      `with code as (update activation_code set used_at = now() where participation_id = $1
         returning id, project_id)
       insert into participant_account (participation_id, project_id, activation_code_id,
         identity_assurance, language)
       select $1, project_id, id, 'birth_date', 'de' from code`,
      [participationId],
    );
    await owner.$client.query(
      `insert into consent_record (id, project_id, participation_id, purpose, channel_id,
         text_version, language, actor_type)
       values ($1, $2, $3, 'portal_contact', $4, 'portal-contact-consent:v1', 'de', 'participant')`,
      [consentId, projectId, participationId, channelId],
    );
    await owner.$client.query(
      `insert into participant_channel (id, project_id, participation_id, kind, address,
         verified_by, consent_id)
       values ($1, $2, $3, 'email', $4, 'one_time_code', $5)`,
      [channelId, projectId, participationId, address, consentId],
    );
  } finally {
    await owner.$client.end();
  }
  return participationId;
}

/**
 * Logs the browser in as a login code would (a session without a step-up of its own): the
 * session row as the owner and its cookie, without a code submission. `afterActivation` is the
 * session that follows an activation with the birth-date step, which counts as stepped up
 * (ADR-0007, step-up).
 */
export async function loggedInAsOwner(
  page: Page,
  baseURL: string,
  participationId: string,
  options: { afterActivation?: boolean } = {},
) {
  const token = randomBytes(32).toString("base64url");
  const owner = createDb(testDatabaseUrls("transfer_e2e").owner);
  try {
    await owner.$client.query(
      `insert into participant_session (token_hash, project_id, participation_id, state,
         step_up_method, step_up_at)
       select $1, project_id, id, 'active', $3::step_up_method, now()
       from participation where id = $2`,
      [
        createHash("sha256").update(token).digest("hex"),
        participationId,
        options.afterActivation ? "birth_date" : "one_time_code",
      ],
    );
  } finally {
    await owner.$client.end();
  }
  // Development's cookie name (the e2e server runs with NODE_ENV=development).
  await page.context().addCookies([{ name: "tp_portal", value: token, url: baseURL }]);
}

/**
 * `count` participations in `imported` of a seeded project no other spec uses, written as the
 * owner (a fixture): Personalnummer `<prefix>-0001`…, the names from `names` in turn; with `wave`
 * the PL first creates the wave W1 through the staff API. Either way `page` then holds the PL's
 * session. Synthetic data only.
 */
export async function worklistParticipations(
  page: Page,
  baseURL: string,
  options: {
    projectId: string;
    prefix: string;
    count: number;
    names: [string, string][];
    wave?: boolean;
  },
) {
  const { projectId } = options;
  const api = page.context().request;
  const headers = { Origin: baseURL };
  await ok(
    api.post("/api/v1/dev/session", {
      headers,
      data: { staffUserId: seedStaffUserIds.projectLead },
    }),
  );
  if (options.wave) {
    await ok(
      api.post(`/api/v1/projects/${projectId}/entry-waves`, {
        headers,
        data: {
          code: "W1",
          name: "Welle 1",
          signingDeadline: "2091-02-15",
          defaultTgStart: "2091-03-01",
          defaultTgEnd: "2092-02-29",
          latestEntryDate: "2091-03-15",
        },
      }),
    );
  }
  const owner = createDb(testDatabaseUrls("transfer_e2e").owner);
  try {
    await owner.$client.query(
      `with created as (
         insert into participation (project_id, status, profiling_status, dsv_status)
         select $1, 'imported', 'not_started', 'not_offered' from generate_series(1, $2)
         returning id
       ), numbered as (
         select id, row_number() over (order by id) as n from created
       )
       insert into participant_identity (participation_id, project_id, personnel_number,
         first_name, last_name)
       select id, $1, $3 || '-' || lpad(n::text, 4, '0'),
         ($4::text[])[1 + (n - 1) % array_length($4::text[], 1)],
         ($5::text[])[1 + (n - 1) % array_length($5::text[], 1)]
       from numbered`,
      [
        projectId,
        options.count,
        options.prefix,
        options.names.map(([first]) => first),
        options.names.map(([, last]) => last),
      ],
    );
  } finally {
    await owner.$client.end();
  }
}
