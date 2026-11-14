import "./setup.ts";

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, before, test } from "node:test";

import { rememberSpace } from "../src/archive/send.ts";
import { archiver, buildRow } from "../src/archive/writer.ts";
import { startWebhookServer } from "../src/server.ts";
import { fakeSpace } from "./fakes.ts";

const KEY = "test-key-0123456789abcdef0123456789";

// The webhook is never exercised here; the API only needs the server.
const fakeApp = {
  async webhook() {
    return { status: 200, headers: {}, body: new Uint8Array() };
  },
};

let server: Server;
let offServer: Server;
let base: string;
let offBase: string;

before(async () => {
  server = await startWebhookServer({ app: fakeApp, port: 0, path: "/spectrum/webhook", apiKey: KEY });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  offServer = await startWebhookServer({ app: fakeApp, port: 0, path: "/spectrum/webhook" });
  offBase = `http://127.0.0.1:${(offServer.address() as AddressInfo).port}`;

  for (let i = 0; i < 3; i += 1) {
    archiver!.archive(
      buildRow({
        provider_message_id: `m${i}`,
        space_id: "chat-1",
        platform: "terminal",
        direction: "inbound",
        sender_id: "u",
        content_type: "text",
        text: `message ${i}`,
        source: "stream",
        provider_timestamp: null,
        recorded_at: new Date(Date.UTC(2026, 10, 10, 12, i)),
      }),
    );
  }
});

after(() => {
  server.close();
  offServer.close();
});

const get = (path: string, key?: string) =>
  fetch(`${base}${path}`, { headers: key === undefined ? {} : { "x-api-key": key } });

const post = (path: string, body: unknown, key = KEY) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "x-api-key": key, "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

test("missing or wrong API key → 401", async () => {
  for (const path of ["/api/messages", "/api/spaces", "/api/spaces/chat-1/messages"]) {
    assert.equal((await get(path)).status, 401, path);
    assert.equal((await get(path, "wrong")).status, 401, path);
    assert.equal((await get(path, `${KEY}x`)).status, 401, path);
  }
  assert.equal((await post("/api/send", { space_id: "x", text: "y" }, "wrong")).status, 401);
  assert.equal((await post("/api/flush", {}, "")).status, 401);
});

test("the API is off without API_KEY, but /health still answers", async () => {
  const response = await fetch(`${offBase}/api/messages`, { headers: { "x-api-key": KEY } });
  assert.equal(response.status, 404);
  assert.match(((await response.json()) as { error: string }).error, /API_KEY/);
  assert.equal((await fetch(`${offBase}/health`)).status, 200);
});

test("GET /api/messages returns rows and caps the limit", async () => {
  const response = await get("/api/messages?limit=100000", KEY);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { limit: number; messages: { text: string }[] };
  assert.equal(body.limit, 500);
  assert.ok(body.messages.length <= 500);
  assert.deepEqual(body.messages.slice(0, 3).map((m) => m.text), ["message 2", "message 1", "message 0"]);

  const two = (await (await get("/api/messages?space_id=chat-1&limit=2", KEY)).json()) as { messages: unknown[] };
  assert.equal(two.messages.length, 2);
});

test("bad query parameters → 400", async () => {
  for (const query of ["limit=abc", "limit=0", "limit=-5", "since=yesterday", "direction=up", "since=2026-11-10&until=2026-11-01"]) {
    assert.equal((await get(`/api/messages?${query}`, KEY)).status, 400, query);
  }
});

test("GET /api/spaces and a thread", async () => {
  const spaces = (await (await get("/api/spaces", KEY)).json()) as {
    spaces: { space_id: string; message_count: number }[];
  };
  assert.equal(spaces.spaces.find((s) => s.space_id === "chat-1")?.message_count, 3);

  const thread = (await (await get("/api/spaces/chat-1/messages", KEY)).json()) as { messages: { text: string }[] };
  assert.deepEqual(thread.messages.map((m) => m.text), ["message 0", "message 1", "message 2"]);
});

test("POST /api/send: unknown space → 404, known space → sent and archived", async () => {
  const unknown = await post("/api/send", { space_id: "never-seen", text: "hi" });
  assert.equal(unknown.status, 404);
  assert.match(((await unknown.json()) as { error: string }).error, /since it started/);

  assert.equal((await post("/api/send", "{not json")).status, 400);
  assert.equal((await post("/api/send", { space_id: "x" })).status, 400);

  const { space, sent } = fakeSpace("api-space");
  rememberSpace(space);
  const ok = await post("/api/send", { space_id: "api-space", text: "hello from the API" });
  assert.equal(ok.status, 200);
  const body = (await ok.json()) as { provider_message_id: string; archive_id: string };
  assert.deepEqual(sent, ["hello from the API"]);
  const row = archiver!.pending().find((r) => r.archive_id === body.archive_id);
  assert.equal(row?.source, "api");
  assert.equal(row?.direction, "outbound");
  assert.equal(row?.provider_message_id, body.provider_message_id);
});

test("POST /api/flush writes the buffer; /health reports it", async () => {
  const flush = await post("/api/flush", {});
  assert.equal(flush.status, 200);
  const result = (await flush.json()) as { written: number; failed: number };
  assert.ok(result.written >= 4);
  assert.equal(result.failed, 0);

  const health = (await (await fetch(`${base}/health`)).json()) as {
    ok: boolean;
    archive: { bufferSize: number; lastFlushAt: string | null; lastFlushError: string | null };
  };
  assert.equal(health.ok, true);
  assert.equal(health.archive.bufferSize, 0);
  assert.ok(health.archive.lastFlushAt);
  assert.equal(health.archive.lastFlushError, null);

  // Flushed rows are still served.
  const rows = (await (await get("/api/messages?space_id=chat-1", KEY)).json()) as { messages: unknown[] };
  assert.equal(rows.messages.length, 3);
});

test("unknown API routes → 404 JSON, wrong method → 405", async () => {
  assert.equal((await get("/api/nope", KEY)).status, 404);
  assert.equal((await post("/api/messages", {})).status, 405);
});
