import { PGlite, type Transaction } from "@electric-sql/pglite";
import type { SqlDatabase } from "./postgres-storage.ts";

function adapt(client: PGlite | Transaction): SqlDatabase {
  return {
    async query(sql, params) {
      const result = await client.query(sql, params as any[] | undefined);
      return {
        rows: result.rows as Record<string, unknown>[],
        affectedRows: result.affectedRows,
      };
    },
    async transaction<T>(fn: (db: SqlDatabase) => Promise<T>) {
      if ("transaction" in client) {
        return client.transaction((tx) => fn(adapt(tx)));
      }
      return fn(adapt(client));
    },
  };
}

/**
 * Local in-process Postgres adapter used for contract tests and local
 * development. Renders the exact same SQL the hosted Neon adapter runs, so
 * both stores are exercised against the same statements.
 */
export function pgliteDatabase(db: PGlite): SqlDatabase {
  return adapt(db);
}
