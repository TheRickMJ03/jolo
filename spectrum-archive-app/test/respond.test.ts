import "./setup.ts";

import assert from "node:assert/strict";
import { test } from "node:test";

import { archiver } from "../src/archive/writer.ts";
import { respond } from "../src/respond.ts";
import { fakeMessage, fakeSpace } from "./fakes.ts";

const rowsFor = (spaceId: string) => archiver!.pending().filter((row) => row.space_id === spaceId);

test("outbound echoes are ignored and not archived", async () => {
  const { space, sent } = fakeSpace("s-echo");
  await respond(space, fakeMessage(space, { direction: "outbound", content: { type: "text", text: "echo: hi" } }));
  assert.deepEqual(sent, []);
  assert.equal(rowsFor("s-echo").length, 0);
});

test("signals are ignored and not archived", async () => {
  const { space, sent } = fakeSpace("s-signals");
  for (const type of ["read", "typing", "unsend", "edit"]) {
    await respond(space, fakeMessage(space, { content: { type } }));
  }
  assert.deepEqual(sent, []);
  assert.equal(rowsFor("s-signals").length, 0);
});

test("a text message gets an echo reply when LLM_MODEL is blank, and both sides are archived", async () => {
  const { space, sent } = fakeSpace("s-text");
  await respond(space, fakeMessage(space, { id: "m-text", content: { type: "text", text: "  hello  " } }));
  assert.deepEqual(sent, ["echo: hello"]);

  const rows = rowsFor("s-text");
  assert.equal(rows.length, 2);
  const [inbound, outbound] = rows;
  assert.equal(inbound?.direction, "inbound");
  assert.equal(inbound?.source, "stream");
  assert.equal(inbound?.provider_message_id, "m-text");
  assert.equal(inbound?.text, "  hello  "); // archived as received, not trimmed
  assert.equal(inbound?.sender_id, "user-1");
  assert.equal(inbound?.provider_timestamp?.toISOString(), "2026-11-10T20:00:00.000Z");

  assert.equal(outbound?.direction, "outbound");
  assert.equal(outbound?.source, "agent");
  assert.equal(outbound?.text, "echo: hello");
  assert.match(outbound?.provider_message_id ?? "", /^out-\d+$/);
});

test("/ping replies pong", async () => {
  const { space, sent } = fakeSpace("s-ping");
  await respond(space, fakeMessage(space, { content: { type: "text", text: "/ping" } }));
  assert.deepEqual(sent, ["pong"]);
});

test("a duplicate message id is replied to and archived only once", async () => {
  const { space, sent } = fakeSpace("s-dup");
  const message = fakeMessage(space, { id: "m-dup", content: { type: "text", text: "once" } });
  await respond(space, message, "stream");
  await respond(space, message, "webhook"); // same delivery arriving the other way
  await respond(space, message, "webhook");

  assert.deepEqual(sent, ["echo: once"]);
  const rows = rowsFor("s-dup");
  assert.equal(rows.filter((row) => row.direction === "inbound").length, 1);
  assert.equal(rows.filter((row) => row.direction === "outbound").length, 1);
});

test("an image message gets one inbound row with text = null", async () => {
  const { space, sent } = fakeSpace("s-image");
  await respond(
    space,
    fakeMessage(space, {
      content: { type: "attachment", id: "a1", name: "cat.png", mimeType: "image/png" },
    }),
  );
  const inbound = rowsFor("s-image").filter((row) => row.direction === "inbound");
  assert.equal(inbound.length, 1);
  assert.equal(inbound[0]?.content_type, "attachment");
  assert.equal(inbound[0]?.text, null);
  assert.deepEqual(sent, ["Received a attachment message."]);
});

test("webhook deliveries are labelled source = webhook", async () => {
  const { space } = fakeSpace("s-webhook");
  await respond(space, fakeMessage(space, { content: { type: "text", text: "via hook" } }), "webhook");
  const inbound = rowsFor("s-webhook").find((row) => row.direction === "inbound");
  assert.equal(inbound?.source, "webhook");
});
