// One in-memory DuckDB instance for the whole process, used only as a Parquet
// engine: it never holds archive data of its own. Every caller gets its own
// connection, so temp tables never collide between a flush and a query.
import {
  DuckDBInstance,
  type DuckDBConnection,
  type DuckDBType,
  type DuckDBValue,
} from "@duckdb/node-api";

import {
  archiveMode,
  archiveRoot,
  awsAccessKeyId,
  awsRegion,
  awsSecretAccessKey,
  awsSessionToken,
} from "../env.ts";
import { type MessageRow, rowParams, valuesTuple } from "./schema.ts";

/**
 * SQL string literal. Used ONLY for operator config (the S3 secret, the
 * archive:query view's root glob) where DuckDB does not accept bind
 * parameters. Never used for anything an API caller or the model supplies.
 */
export function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

let instance: Promise<DuckDBInstance> | undefined;

async function createInstance(): Promise<DuckDBInstance> {
  const db = await DuckDBInstance.create(":memory:");
  if (archiveMode !== "s3") return db;

  const connection = await db.connect();
  try {
    // httpfs handles s3:// reads, writes and globbing. INSTALL downloads the
    // extension once from DuckDB's extension repository and caches it.
    await connection.run("INSTALL httpfs");
    await connection.run("LOAD httpfs");

    const scope = `SCOPE ${sqlString(archiveRoot)}`;
    if (awsAccessKeyId && awsSecretAccessKey) {
      const session = awsSessionToken ? `, SESSION_TOKEN ${sqlString(awsSessionToken)}` : "";
      await connection.run(
        `CREATE OR REPLACE SECRET archive_s3 (TYPE s3, KEY_ID ${sqlString(awsAccessKeyId)}, ` +
          `SECRET ${sqlString(awsSecretAccessKey)}${session}, REGION ${sqlString(awsRegion)}, ${scope})`,
      );
    } else {
      // No keys in .env: use the AWS default chain (profile, SSO, instance role).
      await connection.run("INSTALL aws");
      await connection.run("LOAD aws");
      await connection.run(
        `CREATE OR REPLACE SECRET archive_s3 (TYPE s3, PROVIDER credential_chain, ` +
          `REGION ${sqlString(awsRegion)}, ${scope})`,
      );
    }
    // Objects rely on the bucket's default encryption (SSE-S3, set by
    // archive:setup); nothing here asks for a different scheme.
  } finally {
    connection.closeSync();
  }
  return db;
}

export async function withConnection<T>(fn: (connection: DuckDBConnection) => Promise<T>): Promise<T> {
  // A failed init (no network for INSTALL httpfs, say) is retried next time
  // rather than poisoning every later flush.
  instance ??= createInstance().catch((error: unknown) => {
    instance = undefined;
    throw error;
  });
  const connection = await (await instance).connect();
  try {
    return await fn(connection);
  } finally {
    connection.closeSync();
  }
}

/** Load rows into a table created with `createTableSql`, every value cast to its column type. */
export async function insertRows(
  connection: DuckDBConnection,
  table: string,
  rows: readonly MessageRow[],
): Promise<void> {
  const CHUNK = 200;
  for (let start = 0; start < rows.length; start += CHUNK) {
    const chunk = rows.slice(start, start + CHUNK);
    const width = rowParams(chunk[0]!).length;
    const tuples = chunk.map((_, i) => valuesTuple(i * width));
    const values = chunk.flatMap(rowParams);
    await connection.run(`INSERT INTO ${table} VALUES ${tuples.join(", ")}`, values);
  }
}

/** Every Parquet part file under `{root}/messages`, local or S3. */
export async function listPartFiles(connection: DuckDBConnection, root: string): Promise<string[]> {
  const reader = await connection.runAndReadAll("SELECT file FROM glob($1) ORDER BY file", [
    `${root}/messages/dt=*/hour=*/*.parquet`,
  ]);
  return reader.getRowObjectsJS().map((row) => String(row.file));
}

/** Named-parameter builder, so a query can mix plain values with a typed LIST. */
export class Params {
  readonly values: Record<string, DuckDBValue> = {};
  readonly types: Record<string, DuckDBType | undefined> = {};
  private count = 0;

  add(value: DuckDBValue, type?: DuckDBType): string {
    this.count += 1;
    const key = `p${this.count}`;
    this.values[key] = value;
    if (type) this.types[key] = type;
    return `$${key}`;
  }
}
