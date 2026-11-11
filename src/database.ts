import { readFile } from "node:fs/promises";
import { Pool, type PoolClient } from "pg";

export function createPool(connectionString: string): Pool {
  return new Pool({
    connectionString,
    max: 10,
    // No application deadline while a healthy local database is busy.
    connectionTimeoutMillis: 0,
    statement_timeout: 0,
    lock_timeout: 0,
    application_name: "api-alta-demanda",
  });
}

export async function migrate(pool: Pool): Promise<void> {
  const sql = await readFile(new URL("../db/schema.sql", import.meta.url), "utf8");
  await transaction(pool, async (client) => { await client.query(sql); });
}

export async function transaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      broken = rollbackError instanceof Error
        ? rollbackError : new Error("Rollback failed");
    }
    throw error;
  } finally {
    client.release(broken);
  }
}
