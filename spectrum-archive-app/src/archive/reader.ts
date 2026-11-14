// The read path. Every query unions the Parquet files with the writer's
// not-yet-flushed rows, so results are real-time, and dedupes on archive_id,
// so a row caught mid-flush (in both places at once) appears once.
//
// All caller-supplied values are bind parameters. Partition pruning happens
// twice: the file list is cut to the dt range before DuckDB sees it, and the
// hive `dt` column is filtered as well.
import { LIST, listValue, VARCHAR, type DuckDBConnection } from "@duckdb/node-api";

import { archiveRoot } from "../env.ts";
import { insertRows, listPartFiles, Params, withConnection } from "./duck.ts";
import {
  COLUMN_NAMES,
  createTableSql,
  type Direction,
  type MessageRow,
  READ_COLUMNS,
  rowFromDuck,
} from "./schema.ts";
import { archiver } from "./writer.ts";

export interface ArchiveSource {
  root: string;
  pending(): MessageRow[];
}

/** The live archive as configured in env.ts, including the writer's buffer. */
export const archiveSource: ArchiveSource = {
  root: archiveRoot,
  pending: () => archiver?.pending() ?? [],
};

export interface MessageQuery {
  spaceId?: string;
  platform?: string;
  direction?: Direction;
  /** Inclusive, on recorded_at. */
  since?: Date;
  /** Inclusive, on recorded_at. */
  until?: Date;
  /** Case-insensitive substring of `text`. */
  contains?: string;
  limit: number;
  order: "asc" | "desc";
}

export interface SpaceSummary {
  space_id: string;
  platform: string;
  message_count: number;
  last_message_at: string;
}

const utcDate = (date: Date) => date.toISOString().slice(0, 10);

/**
 * A FROM-clause subquery over every archived row in [since, until]. Loads the
 * pending rows into a temp table on `connection` first.
 */
async function messagesFrom(
  connection: DuckDBConnection,
  source: ArchiveSource,
  params: Params,
  range: { since?: Date; until?: Date },
): Promise<string> {
  await connection.run(createTableSql("pending_rows"));
  await insertRows(connection, "pending_rows", source.pending());

  const fromDt = range.since ? utcDate(range.since) : undefined;
  const toDt = range.until ? utcDate(range.until) : undefined;

  const files = (await listPartFiles(connection, source.root)).filter((file) => {
    const dt = /\/dt=(\d{4}-\d{2}-\d{2})\//.exec(file)?.[1];
    if (!dt) return false;
    return (!fromDt || dt >= fromDt) && (!toDt || dt <= toDt);
  });

  const columns = COLUMN_NAMES.join(", ");
  const branches = [`SELECT ${columns} FROM pending_rows`];

  if (files.length > 0) {
    const where: string[] = [];
    if (fromDt) where.push(`dt >= CAST(${params.add(fromDt)} AS DATE)`);
    if (toDt) where.push(`dt <= CAST(${params.add(toDt)} AS DATE)`);
    branches.unshift(
      `SELECT ${columns} FROM read_parquet(${params.add(listValue(files), LIST(VARCHAR))}, ` +
        `hive_partitioning = true, hive_types = {'dt': DATE, 'hour': INTEGER})` +
        (where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""),
    );
  }

  return `(SELECT DISTINCT ON (archive_id) * FROM (${branches.join(" UNION ALL ")}))`;
}

export async function queryMessages(
  source: ArchiveSource,
  query: MessageQuery,
): Promise<MessageRow[]> {
  const limit = Math.max(1, Math.trunc(query.limit));
  const order = query.order === "asc" ? "ASC" : "DESC";

  return withConnection(async (connection) => {
    const params = new Params();
    const from = await messagesFrom(connection, source, params, query);

    const where: string[] = [];
    if (query.spaceId !== undefined) where.push(`space_id = ${params.add(query.spaceId)}`);
    if (query.platform !== undefined) where.push(`platform = ${params.add(query.platform)}`);
    if (query.direction !== undefined) where.push(`direction = ${params.add(query.direction)}`);
    if (query.since) where.push(`recorded_at >= CAST(${params.add(query.since.toISOString())} AS TIMESTAMPTZ)`);
    if (query.until) where.push(`recorded_at <= CAST(${params.add(query.until.toISOString())} AS TIMESTAMPTZ)`);
    if (query.contains) where.push(`strpos(lower(text), lower(${params.add(query.contains)})) > 0`);

    const sql =
      `SELECT ${READ_COLUMNS} FROM ${from} AS m` +
      (where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "") +
      ` ORDER BY m.recorded_at ${order}, m.archive_id ${order} LIMIT ${limit}`;

    const reader = await connection.runAndReadAll(sql, params.values, params.types);
    return reader.getRowObjectsJS().map(rowFromDuck);
  });
}

/** The latest `limit` messages of one space, oldest first. */
export async function thread(
  source: ArchiveSource,
  spaceId: string,
  limit: number,
): Promise<MessageRow[]> {
  const newestFirst = await queryMessages(source, { spaceId, limit, order: "desc" });
  return newestFirst.reverse();
}

export async function listSpaces(source: ArchiveSource): Promise<SpaceSummary[]> {
  return withConnection(async (connection) => {
    const params = new Params();
    const from = await messagesFrom(connection, source, params, {});
    const reader = await connection.runAndReadAll(
      `SELECT space_id, arg_max(platform, recorded_at) AS platform, count(*) AS message_count, ` +
        `epoch_ms(max(recorded_at)) AS last_ms FROM ${from} AS m ` +
        `GROUP BY space_id ORDER BY last_ms DESC, space_id`,
      params.values,
      params.types,
    );
    return reader.getRowObjectsJS().map((row) => ({
      space_id: String(row.space_id),
      platform: String(row.platform),
      message_count: Number(row.message_count),
      last_message_at: new Date(Number(row.last_ms)).toISOString(),
    }));
  });
}
