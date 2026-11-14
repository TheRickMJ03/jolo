// The write path. `archive(row)` is synchronous and durable before it returns:
// the row goes into the in-memory buffer AND is appended to a JSONL spool, so a
// crash between flushes loses nothing — the spool is replayed on next boot.
//
// A background flusher groups buffered rows by dt/hour, loads each group into
// DuckDB with the schema's exact types, and COPYs it to one Parquet file at
// {root}/messages/dt=YYYY-MM-DD/hour=HH/part-{ts}-{uuid}.parquet. The spool is
// cut down only after a group's write has succeeded.
//
// Failures follow the guide's "degrade, never crash" rule: retried with
// backoff, kept in the spool, logged, and never thrown into the message loop.
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  archiveFlushIntervalMs,
  archiveFlushMaxRows,
  archiveMode,
  archiveRoot,
  archiveSpoolDir,
} from "../env.ts";
import { insertRows, withConnection } from "./duck.ts";
import {
  compactTimestamp,
  createTableSql,
  fromSpoolLine,
  type MessageRow,
  partitionOf,
  toSpoolLine,
  validateRow,
} from "./schema.ts";

export interface WriterOptions {
  root: string;
  spoolDir: string;
  flushIntervalMs: number;
  flushMaxRows: number;
  /** Delays between the 3 attempts. Tests shrink these. */
  retryDelaysMs?: readonly number[];
}

export interface FlushResult {
  written: number;
  failed: number;
  files: { path: string; rows: number }[];
  error: string | null;
}

export interface WriterStatus {
  root: string;
  bufferSize: number;
  lastFlushAt: string | null;
  lastFlushRows: number;
  lastFlushError: string | null;
}

const ATTEMPTS = 3;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class ArchiveWriter {
  readonly root: string;
  readonly spoolFile: string;
  private readonly options: WriterOptions;
  private buffer: MessageRow[] = [];
  private inFlight: MessageRow[] = [];
  private tail: Promise<undefined> | undefined;
  private sizeFlushQueued = false;
  private timer: NodeJS.Timeout | undefined;
  private started = false;
  private spoolErrorLogged = false;
  private lastFlushAt: Date | null = null;
  private lastFlushRows = 0;
  private lastFlushError: string | null = null;

  constructor(options: WriterOptions) {
    this.options = options;
    this.root = options.root.replace(/\/+$/, "");
    this.spoolFile = join(options.spoolDir, "messages.jsonl");
  }

  /** Replay leftover spool rows, then start the interval flusher. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.replay();

    this.timer = setInterval(() => {
      if (this.buffer.length > 0) void this.flush();
    }, this.options.flushIntervalMs);
    // Don't hold the process open just for the flusher; shutdown flushes.
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * Validate, buffer, spool. Never throws: an invalid row is logged and
   * dropped, an unwritable spool is logged and the row stays in memory.
   */
  archive(candidate: MessageRow): MessageRow | undefined {
    let row: MessageRow;
    try {
      row = validateRow(candidate);
    } catch (error) {
      console.error(`[archive] dropped an invalid row: ${String(error)}`);
      return undefined;
    }

    this.buffer.push(row);
    this.appendSpool(row);

    if (this.buffer.length >= this.options.flushMaxRows && !this.sizeFlushQueued) {
      this.sizeFlushQueued = true;
      void this.flush().finally(() => {
        this.sizeFlushQueued = false;
      });
    }
    return row;
  }

  /** Rows not yet in Parquet, including any mid-flush. Readers merge these in. */
  pending(): MessageRow[] {
    return [...this.inFlight, ...this.buffer];
  }

  status(): WriterStatus {
    return {
      root: this.root,
      bufferSize: this.inFlight.length + this.buffer.length,
      lastFlushAt: this.lastFlushAt?.toISOString() ?? null,
      lastFlushRows: this.lastFlushRows,
      lastFlushError: this.lastFlushError,
    };
  }

  /**
   * Flushes are serialized: a call made during a flush waits for it, then
   * runs. When idle, the buffer is snapshotted synchronously, so a flush covers
   * exactly the rows archived before the call.
   */
  flush(): Promise<FlushResult> {
    const run = this.tail ? this.tail.then(() => this.flushNow()) : this.flushNow();
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.tail = tail;
    void tail.then(() => {
      if (this.tail === tail) this.tail = undefined;
    });
    return run;
  }

  private async flushNow(): Promise<FlushResult> {
    if (this.buffer.length === 0) {
      return { written: 0, failed: 0, files: [], error: null };
    }

    this.inFlight = this.buffer;
    this.buffer = [];

    const groups = new Map<string, { dt: string; hour: string; rows: MessageRow[] }>();
    for (const row of this.inFlight) {
      const { dt, hour } = partitionOf(row.recorded_at);
      const key = `${dt}/${hour}`;
      const group = groups.get(key) ?? { dt, hour, rows: [] };
      group.rows.push(row);
      groups.set(key, group);
    }

    const files: FlushResult["files"] = [];
    const failedRows: MessageRow[] = [];
    const errors: string[] = [];

    for (const { dt, hour, rows } of groups.values()) {
      try {
        const path = await this.withRetry(() => this.writeGroup(dt, hour, rows));
        files.push({ path, rows: rows.length });
      } catch (error) {
        failedRows.push(...rows);
        errors.push(`dt=${dt}/hour=${hour}: ${String(error)}`);
      }
    }

    // Unwritten rows go back to the front of the buffer; rows that arrived
    // during the flush are already behind them.
    this.inFlight = [];
    this.buffer = [...failedRows, ...this.buffer];

    // Only when something was written does the spool change, and then only to
    // drop the rows that are now safely in Parquet. A total failure leaves the
    // spool exactly as it was.
    if (files.length > 0) this.rewriteSpool(this.buffer);

    const written = files.reduce((sum, file) => sum + file.rows, 0);
    this.lastFlushAt = new Date();
    this.lastFlushRows = written;
    this.lastFlushError = errors.length > 0 ? errors.join("; ").slice(0, 500) : null;

    if (errors.length > 0) {
      console.error(
        `[archive] flush kept ${failedRows.length} row(s) in the spool after ${ATTEMPTS} attempts: ${this.lastFlushError}`,
      );
    }
    return { written, failed: failedRows.length, files, error: this.lastFlushError };
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    const delays = this.options.retryDelaysMs ?? [500, 2_000];
    let lastError: unknown;
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        if (attempt < ATTEMPTS - 1) await sleep(delays[attempt] ?? delays.at(-1) ?? 1_000);
      }
    }
    throw lastError;
  }

  private async writeGroup(dt: string, hour: string, rows: MessageRow[]): Promise<string> {
    const dir = `${this.root}/messages/dt=${dt}/hour=${hour}`;
    const name = `part-${compactTimestamp(new Date())}-${randomUUID()}.parquet`;
    const path = `${dir}/${name}`;
    const isS3 = this.root.startsWith("s3://");

    // Locally, write beside the target and rename, so a crash mid-COPY never
    // leaves a truncated file that the *.parquet glob would pick up. S3
    // uploads only become visible once complete, so they go straight there.
    const target = isS3 ? path : `${dir}/.${name}.tmp`;
    if (!isS3) mkdirSync(dir, { recursive: true });

    try {
      await withConnection(async (connection) => {
        await connection.run(createTableSql("flush_rows"));
        await insertRows(connection, "flush_rows", rows);
        await connection.run(
          "COPY (SELECT * FROM flush_rows ORDER BY recorded_at, archive_id) TO $1 (FORMAT parquet, COMPRESSION zstd)",
          [target],
        );
      });
      if (!isS3) renameSync(target, path);
    } catch (error) {
      if (!isS3) rmSync(target, { force: true });
      throw error;
    }
    return path;
  }

  private appendSpool(row: MessageRow): void {
    try {
      mkdirSync(this.options.spoolDir, { recursive: true });
      appendFileSync(this.spoolFile, `${toSpoolLine(row)}\n`, "utf8");
    } catch (error) {
      if (!this.spoolErrorLogged) {
        this.spoolErrorLogged = true;
        console.error(
          `[archive] cannot write the spool ${this.spoolFile}; rows are in memory only until the next flush: ${String(error)}`,
        );
      }
    }
  }

  /** Atomic: write beside, then rename. Synchronous, so no append can interleave. */
  private rewriteSpool(rows: readonly MessageRow[]): void {
    try {
      mkdirSync(this.options.spoolDir, { recursive: true });
      const temporary = `${this.spoolFile}.tmp`;
      writeFileSync(temporary, rows.map((row) => `${toSpoolLine(row)}\n`).join(""), "utf8");
      renameSync(temporary, this.spoolFile);
    } catch (error) {
      // The old spool still holds a superset of what is unflushed: at worst a
      // replay re-archives rows (readers dedupe on archive_id), never loses one.
      console.error(`[archive] could not trim the spool: ${String(error)}`);
    }
  }

  private replay(): void {
    if (!existsSync(this.spoolFile)) return;

    let contents: string;
    try {
      contents = readFileSync(this.spoolFile, "utf8");
    } catch (error) {
      console.error(`[archive] could not read the spool, skipping replay: ${String(error)}`);
      return;
    }

    const present = new Set(this.buffer.map((row) => row.archive_id));
    let replayed = 0;
    let skipped = 0;
    for (const line of contents.split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = fromSpoolLine(line);
        if (present.has(row.archive_id)) continue;
        present.add(row.archive_id);
        this.buffer.push(row);
        replayed += 1;
      } catch {
        // A torn final line from a crash mid-append, most likely. Skip it
        // rather than refuse to boot.
        skipped += 1;
      }
    }
    if (replayed > 0 || skipped > 0) {
      console.log(
        `[archive] replayed ${replayed} unflushed row(s) from the spool` +
          (skipped > 0 ? ` (skipped ${skipped} unreadable line(s))` : ""),
      );
    }
  }
}

/** The process-wide writer, or undefined when ARCHIVE_DIR=off. */
export const archiver: ArchiveWriter | undefined =
  archiveMode === "off"
    ? undefined
    : new ArchiveWriter({
        root: archiveRoot,
        spoolDir: archiveSpoolDir,
        flushIntervalMs: archiveFlushIntervalMs,
        flushMaxRows: archiveFlushMaxRows,
      });

/** A row with our own id and clock filled in. */
export function buildRow(
  fields: Omit<MessageRow, "archive_id" | "recorded_at"> & { recorded_at?: Date },
): MessageRow {
  const { recorded_at, ...rest } = fields;
  return { archive_id: randomUUID(), ...rest, recorded_at: recorded_at ?? new Date() };
}
