import { testDir } from "./setup.ts";

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { withConnection } from "../src/archive/duck.ts";
import { DESCRIBED_TYPES, MESSAGE_COLUMNS, type MessageRow } from "../src/archive/schema.ts";
import { ArchiveWriter, buildRow } from "../src/archive/writer.ts";

let n = 0;
function freshDirs() {
  n += 1;
  const base = join(testDir, `writer-${n}`);
  return { root: join(base, "archive"), spoolDir: join(base, "spool") };
}

function makeWriter(dirs: { root: string; spoolDir: string }) {
  return new ArchiveWriter({
    ...dirs,
    flushIntervalMs: 3_600_000,
    flushMaxRows: 100_000,
    retryDelaysMs: [1, 1],
  });
}

function row(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    ...buildRow({
      provider_message_id: "p-1",
      space_id: "space-1",
      platform: "terminal",
      direction: "inbound",
      sender_id: "user-1",
      content_type: "text",
      text: "hello",
      source: "stream",
      provider_timestamp: new Date("2026-11-10T21:14:59.000Z"),
      recorded_at: new Date("2026-11-10T21:15:00.123Z"),
    }),
    ...overrides,
  };
}

const spoolLines = (writer: ArchiveWriter) =>
  existsSync(writer.spoolFile) ? readFileSync(writer.spoolFile, "utf8").split("\n").filter(Boolean) : [];

test("flush writes Parquet with the exact schema at the dt/hour path", async () => {
  const dirs = freshDirs();
  const writer = makeWriter(dirs);
  writer.start();
  writer.archive(row());
  writer.archive(row({ text: null, content_type: "voice", provider_timestamp: null }));
  writer.archive(row({ recorded_at: new Date("2026-11-10T22:00:00.000Z"), direction: "outbound", source: "agent" }));

  const result = await writer.flush();
  writer.stop();
  assert.equal(result.written, 3);
  assert.equal(result.failed, 0);
  assert.equal(result.files.length, 2);

  const first = result.files.find((file) => file.path.includes("hour=21"));
  assert.ok(first);
  assert.equal(first.rows, 2);
  assert.match(
    first.path,
    /\/messages\/dt=2026-11-10\/hour=21\/part-\d{8}T\d{9}Z-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.parquet$/,
  );
  assert.ok(first.path.startsWith(dirs.root));
  assert.ok(result.files.some((file) => file.path.includes("/dt=2026-11-10/hour=22/")));

  await withConnection(async (connection) => {
    const described = await connection.runAndReadAll(
      "DESCRIBE SELECT * FROM read_parquet($1, hive_partitioning = false)",
      [first.path],
    );
    assert.deepEqual(
      described.getRowObjectsJS().map((r) => [r.column_name, r.column_type]),
      MESSAGE_COLUMNS.map((column) => [column.name, DESCRIBED_TYPES[column.type]]),
    );

    const meta = await connection.runAndReadAll(
      "SELECT DISTINCT compression FROM parquet_metadata($1)",
      [first.path],
    );
    assert.deepEqual(meta.getRowObjectsJS().map((r) => r.compression), ["ZSTD"]);

    const values = await connection.runAndReadAll(
      "SELECT text, content_type, epoch_ms(recorded_at) AS ms FROM read_parquet($1, hive_partitioning = false) ORDER BY content_type",
      [first.path],
    );
    assert.deepEqual(values.getRowObjectsJS(), [
      { text: "hello", content_type: "text", ms: BigInt(Date.parse("2026-11-10T21:15:00.123Z")) },
      { text: null, content_type: "voice", ms: BigInt(Date.parse("2026-11-10T21:15:00.123Z")) },
    ]);
  });

  assert.equal(spoolLines(writer).length, 0, "spool is truncated after a fully successful flush");
  assert.equal(writer.status().lastFlushError, null);
});

test("rows survive a simulated crash via spool replay", async () => {
  const dirs = freshDirs();
  const before = makeWriter(dirs);
  before.start();
  const a = before.archive(row({ text: "one" }));
  const b = before.archive(row({ text: "two" }));
  before.stop();
  // "Crash": the process dies with rows buffered and never flushed.
  assert.equal(spoolLines(before).length, 2);

  // A torn last line, as a crash mid-append would leave.
  writeFileSync(before.spoolFile, `${readFileSync(before.spoolFile, "utf8")}{"archive_id":"x`, "utf8");

  const after = makeWriter(dirs);
  after.start();
  after.stop();
  assert.deepEqual(
    after.pending().map((r) => r.archive_id),
    [a?.archive_id, b?.archive_id],
  );

  const result = await after.flush();
  assert.equal(result.written, 2);
  assert.equal(spoolLines(after).length, 0);
});

test("a failed write keeps the spool, and a later flush succeeds", async () => {
  const dirs = freshDirs();
  // A regular file where the messages/ directory must go makes every mkdir fail.
  mkdirSync(dirs.root, { recursive: true });
  writeFileSync(join(dirs.root, "messages"), "not a directory");

  const writer = makeWriter(dirs);
  writer.start();
  writer.stop();
  const kept = writer.archive(row({ text: "keep me" }));

  const failed = await writer.flush();
  assert.equal(failed.written, 0);
  assert.equal(failed.failed, 1);
  assert.ok(failed.error);
  assert.ok(writer.status().lastFlushError);
  assert.equal(writer.pending().length, 1, "the row goes back into the buffer");
  const lines = spoolLines(writer);
  assert.equal(lines.length, 1, "the spool still holds the row");
  assert.equal(JSON.parse(lines[0]!).archive_id, kept?.archive_id);

  rmSync(join(dirs.root, "messages"));
  const ok = await writer.flush();
  assert.equal(ok.written, 1);
  assert.equal(writer.pending().length, 0);
  assert.equal(spoolLines(writer).length, 0);
  assert.equal(writer.status().lastFlushError, null);
});

test("invalid rows are rejected by the schema, not written", () => {
  const writer = makeWriter(freshDirs());
  const bad = writer.archive({ ...row(), direction: "sideways" } as unknown as MessageRow);
  const extra = writer.archive({ ...row(), raw_payload: "{}" } as unknown as MessageRow);
  assert.equal(bad, undefined);
  assert.equal(extra, undefined);
  assert.equal(writer.pending().length, 0);
});

test("rows archived during a flush stay buffered and spooled", async () => {
  const writer = makeWriter(freshDirs());
  writer.archive(row({ text: "first" }));
  const flushing = writer.flush();
  const late = writer.archive(row({ text: "late" })); // arrives mid-flush
  const result = await flushing;
  assert.equal(result.written, 1);
  assert.deepEqual(writer.pending().map((r) => r.archive_id), [late?.archive_id]);
  assert.equal(spoolLines(writer).length, 1);
});
