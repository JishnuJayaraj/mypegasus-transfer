import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient } from "pg";
import * as schema from "./schema";

export type Database = NodePgDatabase<typeof schema> & { $client: Pool };

export function createDb(connectionString: string): Database {
  return drizzle({ client: new Pool({ connectionString }), schema });
}

/**
 * A transaction on one pooled connection, given to `work` both as Drizzle and as the raw client,
 * so a library that takes its own SQL (pg-boss's `send` with `db`) joins it. Commits when `work`
 * resolves, rolls back when it throws.
 */
export async function transactionWithClient<T>(
  db: Database,
  work: (tx: NodePgDatabase<typeof schema>, client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await db.$client.connect();
  try {
    await client.query("begin");
    const result = await work(drizzle({ client, schema }), client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
