import { sql, type AnyColumn, type Database } from "@transfer/db";

/** A timestamp as ISO 8601 UTC with the database's microseconds (exact as a keyset cursor). */
export const utc = (column: AnyColumn) =>
  sql<string>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** Calls a setup function in `db` (a transaction or the pool); returns its result. */
export async function callFunction(db: Pick<Database, "execute">, query: ReturnType<typeof sql>) {
  const { rows } = await db.execute<{ result: string }>(sql`select ${query} as result`);
  return rows[0]!.result;
}

/**
 * The `audit_context` of a staff user acting in a request (never assisted mode here); no request
 * for the seed.
 */
export const auditContext = (staffUserId: string, requestId: string | null) =>
  sql`row('user'::actor_type, ${staffUserId}::uuid, null::uuid, null::text, null::uuid,
    ${requestId}::text, null::text)::audit_context`;
