import postgres, { type Sql } from "postgres";
import type { SqlDatabase } from "./postgres-storage.ts";

/**
 * Structural subset shared by the `postgres` client and its `TransactionSql`
 * handle: enough to run parameterized statements and transactions.
 */
interface PostgresClient {
  unsafe(
    query: string,
    parameters?: readonly unknown[],
  ): Promise<readonly Record<string, unknown>[] & { count?: number }>;
  begin<T>(
    cb: (sql: { unsafe: PostgresClient["unsafe"] }) => T | Promise<T>,
  ): Promise<T>;
}

function queryFor(sql: { unsafe: PostgresClient["unsafe"] }) {
  return async (query: string, params?: readonly unknown[]) => {
    const rows = await sql.unsafe(query, params);
    return {
      rows: rows as unknown as Record<string, unknown>[],
      affectedRows: rows.count,
    };
  };
}

function adapterFor(client: PostgresClient): SqlDatabase {
  const query = queryFor(client);
  return {
    query,
    async transaction<T>(fn: (db: SqlDatabase) => Promise<T>) {
      return client.begin(async (tx) => fn(adapterFor(tx as PostgresClient)));
    },
  };
}

/**
 * Hosted Postgres adapter for Neon and Vercel Postgres. Uses the `postgres`
 * driver (postgres.js) with explicit `$n`-parameter statements, the same SQL
 * the local PGlite adapter runs. Nested `transaction` calls execute on the
 * enclosing transaction client; the store currently performs one atomic
 * statement per operation, so savepoints are not required.
 */
export function neonDatabase(sql: Sql): SqlDatabase {
  return adapterFor(sql as PostgresClient);
}

/** Convenience factory: opens a client from a connection string. */
export function createNeonDatabase(connectionString: string): SqlDatabase {
  return neonDatabase(postgres(connectionString));
}
