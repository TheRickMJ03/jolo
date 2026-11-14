import "./setup.ts";

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, before, test } from "node:test";

import type { Message, Space } from "spectrum-ts";

import { archiver } from "../src/archive/writer.ts";
import { type AgentClient, httpAgent } from "../src/jolo/agent-client.ts";
import { joloState } from "../src/jolo/conversation.ts";
import { createStubAgent } from "../src/jolo/stub-agent.ts";
import type { TurnRequest } from "../src/jolo/types.ts";
import { respond } from "../src/respond.ts";
import { fakeMessage, fakeSpace } from "./fakes.ts";

const OWNER = "+19085551234";
let server: Server;
let agent: AgentClient;
const requests: TurnRequest[] = [];

before(async () => {
  server = createStubAgent({ ownerHandles: [OWNER] });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const real = httpAgent(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, undefined, 5_000);
  // Record what the bridge sends, then pass it through to the real HTTP stub.
  agent = { turn: (request) => (requests.push(request), real.turn(request)) };
});

after(() => {
  server.close();
});

let n = 0;
function chat(handle: string) {
  n += 1;
  const { space, sent } = fakeSpace(`chat-${n}`, "imessage");
  const send = async (content: Record<string, unknown>) => {
    const before = sent.length;
    await respond(space, fakeMessage(space, { content, senderId: handle }), "stream", { agent });
    return sent.slice(before);
  };
  return {
    space,
    sent,
    text: (text: string) => send({ type: "text", text }),
    photo: (caption?: string) =>
      send(
        caption
          ? { type: "group", items: [photoMessage(space), textMessage(space, caption)] }
          : photoContent(),
      ),
  };
}

function photoContent(name = "IMG_0042.HEIC") {
  return {
    type: "attachment",
    id: name,
    name,
    mimeType: "image/heic",
    size: 4,
    read: async () => Buffer.from("fake"),
  };
}
const photoMessage = (space: Space): Message => fakeMessage(space, { content: photoContent() });
const textMessage = (space: Space, text: string): Message => fakeMessage(space, { content: { type: "text", text } });

async function onboard(c: ReturnType<typeof chat>, name: string, role: string) {
  await c.text("hi");
  await c.text(name);
  return c.text(role);
}

test("onboarding asks name, then owner or customer, then explains", async () => {
  const c = chat(OWNER);
  assert.deepEqual(await c.text("hello"), ["Hi! I'm JOLO ☕ I keep café menus up to date. What's your name?"]);
  assert.deepEqual(await c.text("I'm barbara!"), ["Nice to meet you, Barbara! Are you a café owner or a customer?"]);
  assert.deepEqual(await c.text("hmm"), ['Just reply "owner" if you run a café, or "customer" if you\'re looking for one.']);
  const [welcome] = await c.text("I own the place");
  assert.match(welcome!, /match you to your café by this phone number/);
  assert.deepEqual(joloState(c.space.id), { name: "Barbara", role: "owner" });
  assert.equal(requests.filter((r) => r.conversation_id === c.space.id).length, 0, "onboarding never calls the agent");
});

test("owner flow, partial menu: scope → summary → yes → updated (sequence steps 1–21)", async () => {
  const c = chat(OWNER);
  await onboard(c, "Barbara", "owner");

  assert.deepEqual(await c.photo("update the menu"), ["Is this your full menu, or just part of it?"]);
  const first = requests.at(-1)!;
  assert.equal(first.event.type, "message");
  assert.equal(first.sender.handle, OWNER, "handle comes from the transport");
  assert.equal(first.sender.role, "owner");
  assert.equal(first.event.type === "message" && first.event.text, "update the menu");
  assert.equal(first.event.type === "message" && first.event.photos[0]?.mime_type, "image/heic");
  assert.equal(first.event.type === "message" && first.event.photos[0]?.data_base64, Buffer.from("fake").toString("base64"));

  const [summary] = await c.text("Just part of it");
  assert.deepEqual(requests.at(-1)!.event, { type: "scope", scope: "partial" });
  assert.match(summary!, /^Found 2 new items and 3 price changes\. Cortado now \$4\.75\?/);
  assert.match(summary!, /\+ Oat Latte \$5\.00/);
  assert.match(summary!, /• Cortado \$4\.50 → \$4\.75/);
  assert.doesNotMatch(summary!, /removed/, "a partial photo removes nothing");
  assert.match(summary!, /Reply "yes" to save, or "no" to cancel\.$/);

  assert.deepEqual(await c.text("maybe?"), ['Reply "yes" to save these changes, or "no" to leave your menu as it is.']);
  assert.equal(requests.at(-1)!.event.type, "scope", "an unclear answer doesn't reach the agent");

  assert.deepEqual(await c.text("Yes, all correct"), ["Your menu is updated ✅"]);
  assert.deepEqual(requests.at(-1)!.event, { type: "confirm", confirmed: true });
  assert.equal(joloState(c.space.id).pending, undefined);
});

test("customer asks afterwards and gets the new prices (steps 22–27)", async () => {
  const c = chat("+12015550000");
  await onboard(c, "Sam", "customer");
  const [answer] = await c.text("What's on the menu at Barbara's?");
  assert.match(answer!, /Cortado \$4\.75/);
  assert.match(answer!, /\(updated today\)$/);
});

test("full menu shows removals; no cancels", async () => {
  const c = chat(OWNER);
  await onboard(c, "Barbara", "1");
  await c.photo();
  const [summary] = await c.text("the whole thing");
  assert.match(summary!, /removed item/);
  assert.match(summary!, /– Croissant \(removed\)/);
  assert.deepEqual(await c.text("no"), ["Okay, nothing changed. Send another photo whenever you're ready."]);
});

test("a photo from a handle that owns no café gets not_owner", async () => {
  const c = chat("+15550000000");
  await onboard(c, "Mallory", "owner"); // claiming to be an owner changes nothing
  assert.deepEqual(await c.photo(), [
    "I couldn't find a café linked to this phone number. Ask the JOLO team to link it, then send the photo again.",
  ]);
});

test("a photo sent before onboarding is asked for again afterwards", async () => {
  const c = chat(OWNER);
  await c.photo("update the menu");
  await c.text("Barbara");
  assert.deepEqual(await c.text("owner"), [
    'Great! I\'ll match you to your café by this phone number. Whenever your menu changes, text me a photo of it and say "update the menu".',
    "Send that photo again and I'll read it.",
  ]);
});

test("agent down: friendly error, and the pending question survives", async () => {
  const c = chat(OWNER);
  await onboard(c, "Barbara", "owner");
  await c.photo();
  assert.equal(joloState(c.space.id).pending, "scope");

  const down: AgentClient = httpAgent("http://127.0.0.1:9", undefined, 1_000);
  const before = c.sent.length;
  await respond(c.space, fakeMessage(c.space, { content: { type: "text", text: "part" }, senderId: OWNER }), "stream", {
    agent: down,
  });
  assert.deepEqual(c.sent.slice(before), ["I couldn't reach the menu service just now. Please try again in a minute."]);
  assert.equal(joloState(c.space.id).pending, "scope");

  // Answering again (agent back up) goes through as the scope answer.
  const [reply] = await c.text("part");
  assert.deepEqual(requests.at(-1)!.event, { type: "scope", scope: "partial" });
  assert.notEqual(reply, "I couldn't reach the menu service just now. Please try again in a minute.");
});

test("too many photos and unsupported content", async () => {
  const c = chat(OWNER);
  await onboard(c, "Barbara", "owner");
  const six = Array.from({ length: 6 }, (_, i) => fakeMessage(c.space, { content: photoContent(`p${i}.jpg`) }));
  const replies = await (async () => {
    const before = c.sent.length;
    await respond(c.space, fakeMessage(c.space, { content: { type: "group", items: six }, senderId: OWNER }), "stream", {
      agent,
    });
    return c.sent.slice(before);
  })();
  assert.deepEqual(replies, [
    "I can read up to 5 photos at a time. I'll use the first 5.",
    "Is this your full menu, or just part of it?",
  ]);
  const last = requests.at(-1)!;
  assert.equal(last.event.type === "message" && last.event.photos.length, 5);

  const voice = chat(OWNER);
  await onboard(voice, "Barbara", "owner");
  const calls = requests.length;
  const before = voice.sent.length;
  await respond(
    voice.space,
    fakeMessage(voice.space, {
      content: { type: "voice", mimeType: "audio/m4a", read: async () => Buffer.from("x") },
      senderId: OWNER,
    }),
    "stream",
    { agent },
  );
  assert.deepEqual(voice.sent.slice(before), ["I can only read photos and text for now."]);
  assert.equal(requests.length, calls, "unsupported content alone doesn't reach the agent");
});

test("commands still work in JOLO mode, and every JOLO message is archived", async () => {
  const c = chat(OWNER);
  await onboard(c, "Barbara", "owner");
  assert.deepEqual(await c.text("/ping"), ["pong"]);
  const [whoami] = await c.text("/whoami");
  assert.match(whoami!, /name:\s+Barbara/);
  assert.match(whoami!, /role:\s+owner/);

  const rows = archiver!.pending().filter((row) => row.space_id === c.space.id);
  assert.equal(rows.filter((r) => r.direction === "inbound").length, 5);
  assert.equal(rows.filter((r) => r.direction === "outbound").length, 5);

  await c.text("/reset");
  assert.deepEqual(joloState(c.space.id), {}, "/reset starts onboarding over");
});
