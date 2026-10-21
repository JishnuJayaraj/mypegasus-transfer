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
// self-service.spec.ts its login (2), sensitive.spec.ts its step-up (2). Synthetic data only.

const ok = async (response: Promise<{ ok(): boolean; status(): number }>) =>
  expect((await response).ok()).toBe(true);

/**
 * An activated participant of `projectId` (born 01.01.1970, the birth-date assurance) with a
 * verified private email `address`, as a letter's activation leaves them. The PL issues the letter
 * and, with `agenturKey`, places the participation through the staff API first.
 */
export async function activatedParticipant(
  page: Page,
  baseURL: string,
  options: { projectId: string; address: string; agenturKey?: string },
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
 * session row as the owner and its cookie, without a code submission.
 */
export async function loggedInAsOwner(page: Page, baseURL: string, participationId: string) {
  const token = randomBytes(32).toString("base64url");
  const owner = createDb(testDatabaseUrls("transfer_e2e").owner);
  try {
    await owner.$client.query(
      `insert into participant_session (token_hash, project_id, participation_id, state,
         step_up_method, step_up_at)
       select $1, project_id, id, 'active', 'one_time_code', now()
       from participation where id = $2`,
      [createHash("sha256").update(token).digest("hex"), participationId],
    );
  } finally {
    await owner.$client.end();
  }
  // Development's cookie name (the e2e server runs with NODE_ENV=development).
  await page.context().addCookies([{ name: "tp_portal", value: token, url: baseURL }]);
}
