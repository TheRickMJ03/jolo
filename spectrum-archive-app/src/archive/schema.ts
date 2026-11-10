// The one place the archive's shape is defined: the TypeScript row type and
// the DuckDB/Parquet column schema it must match. Every write goes through
// `validateRow`, and every DuckDB load casts each value to the column type
// listed here, so a file can never be written with a drifted schema.
//
// Parquet is immutable, so the archive is an append-only event log. Nothing
// ever rewrites a file to update a row.

export const DIRECTIONS = ["inbound", "outbound"] as const;
export const SOURCES = ["stream", "webhook", "agent", "api"] as const;

export type Direction = (typeof DIRECTIONS)[number];
export type Source = (typeof SOURCES)[number];

export interface MessageRow {
  archive_id: string;
  provider_message_id: string | null;
  space_id: string;
  platform: string;
  direction: Direction;
  sender_id: string | null;
  content_type: string;
  text: string | null;
  source: Source;
  provider_timestamp: Date | null;
  recorded_at: Date;
}

export type ColumnType = "VARCHAR" | "TIMESTAMPTZ";

export interface Column {
  name: keyof MessageRow;
  type: ColumnType;
  nullable: boolean;
  allowed?: readonly string[];
}

export const MESSAGE_COLUMNS: readonly Column[] = [
  { name: "archive_id", type: "VARCHAR", nullable: false },
  { name: "provider_message_id", type: "VARCHAR", nullable: true },
  { name: "space_id", type: "VARCHAR", nullable: false },
  { name: "platform", type: "VARCHAR", nullable: false },
  { name: "direction", type: "VARCHAR", nullable: false, allowed: DIRECTIONS },
  { name: "sender_id", type: "VARCHAR", nullable: true },
  { name: "content_type", type: "VARCHAR", nullable: false },
  { name: "text", type: "VARCHAR", nullable: true },
  { name: "source", type: "VARCHAR", nullable: false, allowed: SOURCES },
  { name: "provider_timestamp", type: "TIMESTAMPTZ", nullable: true },
  { name: "recorded_at", type: "TIMESTAMPTZ", nullable: false },
];

export const COLUMN_NAMES = MESSAGE_COLUMNS.map((column) => column.name);

/** How DuckDB's DESCRIBE reports each column type when read back from Parquet. */
export const DESCRIBED_TYPES: Record<ColumnType, string> = {
  VARCHAR: "VARCHAR",
  TIMESTAMPTZ: "TIMESTAMP WITH TIME ZONE",
};

export class SchemaError extends Error {}

/** Throws SchemaError unless `value` is exactly a MessageRow: names, types, nullability, enums. */
export function validateRow(value: unknown): MessageRow {
  if (!value || typeof value !== "object") throw new SchemaError("row must be an object");
  const record = value as Record<string, unknown>;

  const known = new Set<string>(COLUMN_NAMES);
  for (const key of Object.keys(record)) {
    if (!known.has(key)) throw new SchemaError(`unknown column: ${key}`);
  }

  const out: Record<string, unknown> = {};
  for (const column of MESSAGE_COLUMNS) {
    const v = record[column.name];
    if (v === null || v === undefined) {
      if (!column.nullable) throw new SchemaError(`${column.name} is required`);
      out[column.name] = null;
      continue;
    }
    if (column.type === "VARCHAR") {
      if (typeof v !== "string") throw new SchemaError(`${column.name} must be a string`);
      if (!column.nullable && v.length === 0) throw new SchemaError(`${column.name} must not be empty`);
      if (column.allowed && !column.allowed.includes(v)) {
        throw new SchemaError(`${column.name} must be one of ${column.allowed.join(", ")}`);
      }
    } else if (!(v instanceof Date) || Number.isNaN(v.getTime())) {
      throw new SchemaError(`${column.name} must be a valid Date`);
    }
    out[column.name] = v;
  }
  return out as unknown as MessageRow;
}

/** Temp-table DDL straight from the schema, so the COPY output types are exact. */
export function createTableSql(table: string): string {
  if (!/^[a-z_]+$/.test(table)) throw new Error(`bad table name: ${table}`);
  const columns = MESSAGE_COLUMNS.map(
    (column) => `${column.name} ${column.type}${column.nullable ? "" : " NOT NULL"}`,
  );
  return `CREATE OR REPLACE TEMP TABLE ${table} (${columns.join(", ")})`;
}

/** One `(CAST($n AS TYPE), …)` tuple per row, numbered from `offset + 1`. */
export function valuesTuple(offset: number): string {
  const casts = MESSAGE_COLUMNS.map(
    (column, i) => `CAST($${offset + i + 1} AS ${column.type})`,
  );
  return `(${casts.join(", ")})`;
}

/** Bind values for one row, in column order. Timestamps travel as ISO strings. */
export function rowParams(row: MessageRow): (string | null)[] {
  return MESSAGE_COLUMNS.map((column) => {
    const v = row[column.name];
    if (v === null) return null;
    return v instanceof Date ? v.toISOString() : v;
  });
}

/**
 * SELECT list for reading rows back. Timestamps come out as epoch milliseconds
 * so the conversion to Date never depends on the session time zone.
 */
export const READ_COLUMNS = MESSAGE_COLUMNS.map((column) =>
  column.type === "TIMESTAMPTZ" ? `epoch_ms(${column.name}) AS ${column.name}` : column.name,
).join(", ");

export function rowFromDuck(record: Record<string, unknown>): MessageRow {
  const out: Record<string, unknown> = {};
  for (const column of MESSAGE_COLUMNS) {
    const v = record[column.name];
    if (column.type === "TIMESTAMPTZ") {
      out[column.name] = v === null || v === undefined ? null : new Date(Number(v));
    } else {
      out[column.name] = v ?? null;
    }
  }
  return validateRow(out);
}

/** Spool lines are JSON with ISO timestamps. */
export function toSpoolLine(row: MessageRow): string {
  return JSON.stringify(row);
}

export function fromSpoolLine(line: string): MessageRow {
  const parsed = JSON.parse(line) as Record<string, unknown>;
  for (const column of MESSAGE_COLUMNS) {
    const v = parsed[column.name];
    if (column.type === "TIMESTAMPTZ" && typeof v === "string") parsed[column.name] = new Date(v);
  }
  return validateRow(parsed);
}

/** Hive partition for a row, from our own UTC clock. */
export function partitionOf(date: Date): { dt: string; hour: string } {
  const iso = date.toISOString();
  return { dt: iso.slice(0, 10), hour: iso.slice(11, 13) };
}

/** 2026-11-10T21:15:00.123Z → 20261110T211500123Z */
export function compactTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(".", "");
}
