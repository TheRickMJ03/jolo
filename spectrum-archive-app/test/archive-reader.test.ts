import { testDir } from "./setup.ts";

import assert from "node:assert/strict";
import { join } from "node:path";
import { before, test } from "node:test";

import { type ArchiveSource, listSpaces, queryMessages, thread } from "../src/archive/reader.ts";
import type { MessageRow } from "../src/archive/schema.ts";
import { ArchiveWriter, buildRow } from "../src/archive/writer.ts";

const writer = new ArchiveWriter({
  root: join(testDir, "reader", "archive"),
  spoolDir: join(testDir, "reader", "spool"),
  flushIntervalMs: 3_600_000,
  flushMaxRows: 100_000,
  retryDelaysMs: [1, 1],
});
let extraPending: MessageRow[] = [];
const source: ArchiveSource = {
  root: writer.root,
  pending: () => [...writer.pending(), ...extraPending],
};

function add(at: string, fields: Partial<MessageRow>): MessageRow {
  const row = writer.archive(
    buildRow({
      provider_message_id: null,
      space_id: "alpha",
      platform: "terminal",
      direction: "inbound",
      sender_id: "u1",
      content_type: "text",
      text: "hi",
      source: "stream",
      provider_timestamp: null,
      recorded_at: new Date(at),
      ...fields,
    }),
  );
  assert.ok(row);
  return row;
}

let flushed: MessageRow[] = [];

before(async () => {
  // Flushed to Parquet, across two days and three hour partitions…
  flushed = [
    add("2026-11-08T09:00:00Z", { text: "old alpha" }),
    add("2026-11-09T10:00:00Z", { text: "beta hello", space_id: "beta", platform: "telegram" }),
    add("2026-11-09T10:30:00Z", { text: "alpha reply", direction: "outbound", source: "agent" }),
    add("2026-11-09T11:00:00Z", { text: "Hello again", space_id: "beta", platform: "telegram" }),
  ];
  const result = await writer.flush();
  assert.equal(result.written, 4);
  assert.equal(result.files.length, 3); // 11-08 h09, 11-09 h10 (two rows), 11-09 h11
  // …and still buffered, not yet flushed.
  add("2026-11-10T12:00:00Z", { text: "buffered alpha" });
  add("2026-11-10T12:05:00Z", { text: "buffered beta", space_id: "beta", platform: "telegram" });
});

test("flushed and buffered rows are merged, newest first", async () => {
  const rows = await queryMessages(source, { limit: 100, order: "desc" });
  assert.deepEqual(
    rows.map((r) => r.text),
    ["buffered beta", "buffered alpha", "Hello again", "alpha reply", "beta hello", "old alpha"],
  );
});

test("filters: space, platform, direction, since/until, contains, limit", async () => {
  const alpha = await queryMessages(source, { spaceId: "alpha", limit: 100, order: "desc" });
  assert.deepEqual(alpha.map((r) => r.text), ["buffered alpha", "alpha reply", "old alpha"]);

  const telegram = await queryMessages(source, { platform: "telegram", limit: 100, order: "desc" });
  assert.equal(telegram.length, 3);
  assert.ok(telegram.every((r) => r.space_id === "beta"));

  const outbound = await queryMessages(source, { direction: "outbound", limit: 100, order: "desc" });
  assert.deepEqual(outbound.map((r) => r.text), ["alpha reply"]);

  const window = await queryMessages(source, {
    since: new Date("2026-11-09T10:15:00Z"),
    until: new Date("2026-11-10T12:00:00Z"),
    limit: 100,
    order: "asc",
  });
  assert.deepEqual(window.map((r) => r.text), ["alpha reply", "Hello again", "buffered alpha"]);

  const hello = await queryMessages(source, { contains: "HELLO", limit: 100, order: "desc" });
  assert.deepEqual(hello.map((r) => r.text), ["Hello again", "beta hello"]);

  // A LIKE wildcard in the search text is matched literally, not as a pattern.
  const wildcard = await queryMessages(source, { contains: "%", limit: 100, order: "desc" });
  assert.equal(wildcard.length, 0);

  const limited = await queryMessages(source, { limit: 2, order: "desc" });
  assert.deepEqual(limited.map((r) => r.text), ["buffered beta", "buffered alpha"]);
});

test("a row in both the buffer and Parquet (mid-flush) appears once", async () => {
  extraPending = [flushed[0]!];
  try {
    const rows = await queryMessages(source, { spaceId: "alpha", limit: 100, order: "desc" });
    assert.equal(rows.filter((r) => r.text === "old alpha").length, 1);
    const spaces = await listSpaces(source);
    assert.equal(spaces.find((s) => s.space_id === "alpha")?.message_count, 3);
  } finally {
    extraPending = [];
  }
});

test("thread is chronological; spaces have counts and last message time", async () => {
  const beta = await thread(source, "beta", 1000);
  assert.deepEqual(beta.map((r) => r.text), ["beta hello", "Hello again", "buffered beta"]);

  const latestTwo = await thread(source, "beta", 2);
  assert.deepEqual(latestTwo.map((r) => r.text), ["Hello again", "buffered beta"]);

  const spaces = await listSpaces(source);
  assert.deepEqual(spaces, [
    { space_id: "beta", platform: "telegram", message_count: 3, last_message_at: "2026-11-10T12:05:00.000Z" },
    { space_id: "alpha", platform: "terminal", message_count: 3, last_message_at: "2026-11-10T12:00:00.000Z" },
  ]);
});

test("an empty archive reads as empty, not as an error", async () => {
  const empty: ArchiveSource = { root: join(testDir, "nothing-here"), pending: () => [] };
  assert.deepEqual(await queryMessages(empty, { limit: 10, order: "desc" }), []);
  assert.deepEqual(await listSpaces(empty), []);
});
