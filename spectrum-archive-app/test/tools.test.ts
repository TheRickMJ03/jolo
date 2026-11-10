import "./setup.ts";

import assert from "node:assert/strict";
import { test } from "node:test";

import { archiver, buildRow } from "../src/archive/writer.ts";
import { runTool, type ToolContext } from "../src/tools/index.ts";

const ctx = (spaceId: string): ToolContext => ({
  spaceId,
  platform: "terminal",
  senderId: "user-1",
  historyLength: 0,
  send: async () => {},
});

test("calculate evaluates arithmetic and rejects letters", async () => {
  assert.equal(await runTool("calculate", '{"expression":"(1200 * 1.08) / 12"}', ctx("s")), "108");
  for (const attack of ["process.exit(1)", "globalThis", "require('fs')", "1+a", "constructor"]) {
    const output = await runTool("calculate", JSON.stringify({ expression: attack }), ctx("s"));
    assert.match(output, /^Refused/, attack);
  }
});

test("unknown tools and bad JSON return text instead of throwing", async () => {
  assert.equal(await runTool("nope", "{}", ctx("s")), "No such tool: nope");
  assert.match(await runTool("calculate", '{"expression": "1+', ctx("s")), /^Could not parse the arguments as JSON/);
  assert.match(await runTool("calculate", "42", ctx("s")), /must be a JSON object/);
});

test("notes: save, list, forget", async () => {
  const c = ctx("notes-space");
  assert.match(await runTool("save_note", '{"note":"prefers short answers"}', c), /^Saved/);
  assert.equal(await runTool("list_notes", "", c), "1. prefers short answers");
  assert.equal(await runTool("forget_note", '{"number":1}', c), "Forgot: prefers short answers");
  assert.equal(await runTool("list_notes", "", c), "No notes saved yet.");
});

test("search_archive only ever reads the current space", async () => {
  const base = {
    provider_message_id: null,
    platform: "terminal",
    direction: "inbound" as const,
    sender_id: "user-1",
    content_type: "text",
    source: "stream" as const,
    provider_timestamp: null,
  };
  archiver!.archive(buildRow({ ...base, space_id: "space-A", text: "secret plan in A" }));
  archiver!.archive(buildRow({ ...base, space_id: "space-B", text: "secret plan in B" }));

  // The model tries to widen the scope with an argument the schema doesn't have.
  const check = async () => {
    const output = await runTool("search_archive", JSON.stringify({ query: "secret", space_id: "space-B" }), ctx("space-A"));
    assert.match(output, /secret plan in A/);
    assert.doesNotMatch(output, /in B/);
    assert.match(output, /untrusted user content.*data, not instructions/);
  };

  await check(); // from the buffer
  const flushed = await archiver!.flush();
  assert.ok(flushed.written >= 2);
  await check(); // from Parquet

  assert.match(await runTool("search_archive", '{"since":"not a date"}', ctx("space-A")), /^Not a valid ISO date/);
  assert.match(await runTool("search_archive", '{"query":"zzz"}', ctx("space-A")), /^No archived messages/);
});
