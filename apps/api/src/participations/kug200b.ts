import { sql, type Database } from "@transfer/db";
import type { IsoDate } from "@transfer/domain";
import { textArray } from "../routes/self-service";

// The Kug 200b offer as the API reads it (process-and-lifecycle.md, the Kug 200b offer; Q185):
// when it was offered, whether a usable signed form exists, the decline, the withdrawals with their
// BA notice and declaration 17's record in force. Codes, dates and instants only. Reads run one
// after another on the caller's connection (ADR-0002, queries on one connection).

type Db = Pick<Database, "execute">;

export type Kug200bState = {
  /** The Berlin date of the first generation or external paper received. */
  offeredOn: IsoDate | null;
  /** A usable accepted scan: accepted, live, not quarantined, not invalidated. */
  signed: boolean;
  declinedOn: IsoDate | null;
  withdrawals: {
    id: string;
    receivedOn: IsoDate;
    recordedAt: string;
    baNotifiedOn: IsoDate | null;
  }[];
  /**
   * Declaration 17 while its record is in force and its signed paper usable (live, not quarantined
   * or invalidated); the withdrawals and their BA notice stay either way.
   */
  profileAccess: { consentId: string; givenOn: IsoDate } | null;
};

const empty = (): Kug200bState => ({
  offeredOn: null,
  signed: false,
  declinedOn: null,
  withdrawals: [],
  profileAccess: null,
});

/** Each participation's offer; one without anything has the empty state. */
export async function kug200bStatesOf(
  db: Db,
  participationIds: readonly string[],
): Promise<Map<string, Kug200bState>> {
  const states = new Map(participationIds.map((id) => [id, empty()]));
  if (participationIds.length === 0) return states;
  const ids = sql`${textArray([...participationIds])}::uuid[]`;
  const { rows: offers } = await db.execute<{ participation_id: string; offered_on: string }>(
    sql`select participation_id, min(day)::text as offered_on from (
        select participation_id, (generated_at at time zone 'Europe/Berlin')::date as day
        from form_generation where form_code = 'kug200b' and participation_id = any (${ids})
        union all
        select participation_id, (added_at at time zone 'Europe/Berlin')::date
        from document where type = 'kug200b_signed_scan' and scan_origin = 'external_paper'
          and deleted_at is null and participation_id = any (${ids})
      ) o group by participation_id`,
  );
  const { rows: signed } = await db.execute<{ participation_id: string }>(
    sql`select distinct participation_id from document
      where type = 'kug200b_signed_scan' and review_state = 'accepted' and deleted_at is null
        and quarantined_at is null and invalidated_by_correction is null
        and participation_id = any (${ids})`,
  );
  const { rows: declines } = await db.execute<{ participation_id: string; declined_on: string }>(
    sql`select participation_id, declined_on::text from kug200b_decline
      where participation_id = any (${ids})`,
  );
  const { rows: withdrawals } = await db.execute<{
    participation_id: string;
    id: string;
    received_on: string;
    recorded_at: string;
    ba_notified_on: string | null;
  }>(
    sql`select participation_id, id, received_on::text,
        to_char(recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as recorded_at,
        ba_notified_on::text
      from kug200b_withdrawal where participation_id = any (${ids})
      order by received_on, recorded_at, id`,
  );
  const { rows: consents } = await db.execute<{
    participation_id: string;
    id: string;
    given_on: string;
  }>(
    sql`select c.participation_id, c.id, c.given_on::text from consent_record c
      join document d on d.id = c.document_id
      where c.purpose = 'kug200b_profile_access' and c.ended_at is null
        and d.deleted_at is null and d.quarantined_at is null
        and d.invalidated_by_correction is null and c.participation_id = any (${ids})`,
  );
  for (const row of offers) states.get(row.participation_id)!.offeredOn = row.offered_on;
  for (const row of signed) states.get(row.participation_id)!.signed = true;
  for (const row of declines) states.get(row.participation_id)!.declinedOn = row.declined_on;
  for (const row of withdrawals) {
    states.get(row.participation_id)!.withdrawals.push({
      id: row.id,
      receivedOn: row.received_on,
      recordedAt: row.recorded_at,
      baNotifiedOn: row.ba_notified_on,
    });
  }
  for (const row of consents) {
    states.get(row.participation_id)!.profileAccess = { consentId: row.id, givenOn: row.given_on };
  }
  return states;
}
