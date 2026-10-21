import pg from 'pg';

// Return bigint columns (durations, sizes) as numbers; they stay far below 2^53.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number.parseInt(value, 10));

export type Db = pg.Pool;
export type DbClient = pg.PoolClient;

export function createPool(connectionString: string, max: number): Db {
  return new pg.Pool({ connectionString, max });
}

export async function withTransaction<T>(db: Db, fn: (client: DbClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
