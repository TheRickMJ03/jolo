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
import type { NewReview } from "../src/jolo/reviews.ts";
import type { TurnRequest } from "../src/jolo/types.ts";
import { respond } from "../src/respond.ts";
import { fakeMessage, fakeSpace } from "./fakes.ts";

const OWNER = "+19085551234";
const READING = "Reading your menu… this can take a minute.";
const READING_MORE = "Got it, reading that one too…";
let agent: AgentClient;
const requests: TurnRequest[] = [];

const servers: Server[] = [];

/** A stub agent with an untouched café (menu version 3), recording what the bridge sends it. */
async function startStub(): Promise<AgentClient> {
  const stub = createStubAgent({ ownerHandles: [OWNER] });
  servers.push(stub);
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const real = httpAgent(`http://127.0.0.1:${(stub.address() as AddressInfo).port}`, undefined, 5_000);
  return { turn: (request) => (requests.push(request), real.turn(request)) };
}

before(async () => {
  // Shared by the tests that follow one café through an update, in order.
  agent = await startStub();
});

after(() => {
  for (const stub of servers) stub.close();
});

let n = 0;
function chat(handle: string, via: AgentClient = agent, reviewDelayMs?: number) {
  n += 1;
  const { space, sent } = fakeSpace(`chat-${n}`, "imessage");
  const linked: { phone: string; name: string; businessName: string; location: string }[] = [];
  const asks: { phone: string; text: string }[] = [];
  const reviews: NewReview[] = [];
  let failReview = false;
  const send = async (content: Record<string, unknown>) => {
    const before = sent.length;
    await respond(space, fakeMessage(space, { content, senderId: handle }), "stream", {
      agent: via,
      linkOwner: async (profile) => {
        linked.push(profile);
      },
      recordAsk: async (phone, text) => {
        asks.push({ phone, text });
      },
      saveReview: async (review) => {
        if (failReview) throw new Error("firestore down");
        reviews.push(review);
      },
      ...(reviewDelayMs !== undefined ? { reviewDelayMs } : {}),
    });
    return sent.slice(before);
  };
  return {
    space,
    sent,
    linked,
    asks,
    reviews,
    failNextReview: (fail = true) => {
      failReview = fail;
    },
    text: (text: string) => send({ type: "text", text }),
    photo: (caption?: string, name?: string) =>
      send(
        caption
          ? { type: "group", items: [photoMessage(space), textMessage(space, caption)] }
          : photoContent(name),
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
  if (role === "customer") return c.text("user");
  await c.text(role === "1" ? "1" : "owner");
  return c.text(`${name}, ${name}'s, Westfield`);
}

test("onboarding asks owner or user, then name, business, and location", async () => {
  const c = chat(OWNER);
  assert.deepEqual(await c.text("hello"), ["Are you an owner or a user?"]);
  assert.deepEqual(await c.text("hmm"), ['Reply "owner" if you run the café, or "user" if you don\'t.']);
  assert.deepEqual(await c.text("I own the place"), ["What is your name, business name, and location?"]);
  assert.deepEqual(await c.text("just barbara"), [
    'Send all three, separated by commas. For example: "Isaiah, Barbara\'s, Westfield".',
  ]);
  const [welcome] = await c.text("Barbara, Barbara's, Westfield");
  assert.match(welcome!, /Thanks, Barbara\. Barbara's in Westfield is linked to this phone number/);
  assert.deepEqual(joloState(c.space.id), {
    name: "Barbara",
    businessName: "Barbara's",
    location: "Westfield",
    role: "owner",
  });
  assert.deepEqual(c.linked, [
    { phone: OWNER, name: "Barbara", businessName: "Barbara's", location: "Westfield" },
  ]);
  assert.equal(requests.filter((r) => r.conversation_id === c.space.id).length, 0, "onboarding never calls the agent");
});

test("owner flow, partial menu: scope → summary → yes → updated (sequence steps 1–21)", async () => {
  const c = chat(OWNER);
  await onboard(c, "Barbara", "owner");

  assert.deepEqual(
    await c.photo("update the menu"),
    [READING, "Is this your full menu, or just part of it?"],
    "the wait message goes out before the agent is called",
  );
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
  assert.match(summary!, /Reply "yes" to save or "no" to cancel\. If something is off, tell me what to fix\.$/);

  const [again] = await c.text("maybe?");
  assert.match(again!, /^Reply "yes" to save these changes, or "no" to leave your menu as it is\./);
  assert.equal(requests.at(-1)!.event.type, "scope", "an unclear answer doesn't reach the agent");

  assert.deepEqual(await c.text("Yes, all correct"), ["Your menu is updated ✅"]);
  assert.deepEqual(requests.at(-1)!.event, { type: "confirm", confirmed: true });
  assert.equal(joloState(c.space.id).pending, undefined);
});

test("a user is pointed at the app; no café is linked and the agent is not called", async () => {
  const c = chat("+12015550000");
  const [reply] = await onboard(c, "Sam", "customer");
  assert.match(reply!, /^Welcome to JOLO ☕ Sign in to the JOLO app with this phone number/);
  assert.deepEqual(joloState(c.space.id), { role: "customer" });
  assert.equal(c.linked.length, 0);
  assert.equal(requests.filter((r) => r.conversation_id === c.space.id).length, 0);
});

test("a user's later texts go to the agent as a customer", async () => {
  const c = chat("+12015550001");
  await onboard(c, "Sam", "customer");
  await c.text("what's on the menu at Barbara's?");
  const last = requests.at(-1)!;
  assert.equal(last.conversation_id, c.space.id);
  assert.equal(last.sender.role, "customer");
  assert.equal(last.sender.handle, "+12015550001");
  assert.deepEqual(c.asks, [
    { phone: "+12015550001", text: "what's on the menu at Barbara's?" },
  ]);
});

test("a photo sent before choosing user isn't asked for again", async () => {
  const c = chat("+12015550002");
  await c.photo();
  const replies = await c.text("user");
  assert.equal(replies.length, 1);
  assert.match(replies[0]!, /^Welcome to JOLO/);
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
    READING,
    "I couldn't find a café linked to this phone number. Ask the JOLO team to link it, then send the photo again.",
  ]);
});

test("a photo sent before onboarding is asked for again afterwards", async () => {
  const c = chat(OWNER);
  await c.photo("update the menu");
  await c.text("owner");
  assert.deepEqual(await c.text("Barbara, Barbara's, Westfield"), [
    "Thanks, Barbara. Barbara's in Westfield is linked to this phone number. Sign in to the app with it and you'll see this there.",
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

test("a long menu offers the rest, and asking for it doesn't save or call the agent", async () => {
  const via = await startStub();
  const c = chat(OWNER, via);
  await onboard(c, "Barbara", "owner");
  await c.photo(undefined, "long-menu.jpg");
  const [summary] = await c.text("part");
  assert.match(summary!, /…and \d+ more\. Reply "menu" to see the whole menu\./);
  assert.doesNotMatch(summary!, /Extra 7/);

  const before = requests.length;
  const [full] = await c.text("view the entire menu");
  assert.equal(requests.length, before, "seeing the menu is answered here");
  assert.match(full!, /^Here's the whole menu:/);
  assert.match(full!, /\+ Extra 7 /);
  assert.match(full!, /\+ Oat Latte /);
  assert.doesNotMatch(full!, /…and /);
  assert.match(full!, /Reply "yes" to save or "no" to cancel/);
  assert.equal(joloState(c.space.id).pending, "confirm");

  assert.deepEqual(await c.text("no"), ["Okay, nothing changed. Send another photo whenever you're ready."]);
  assert.equal(joloState(c.space.id).pendingChanges, undefined);
});

test("a correction to the summary goes to the agent and comes back as a new summary", async () => {
  const c = chat(OWNER, await startStub());
  await onboard(c, "Barbara", "owner");
  await c.photo();
  await c.text("part");

  const [fixed] = await c.text("no, the cortado is 4.60");
  assert.deepEqual(requests.at(-1)!.event, { type: "correction", text: "no, the cortado is 4.60" });
  assert.match(fixed!, /• Cortado \$4\.50 → \$4\.60/);
  assert.equal(joloState(c.space.id).pending, "confirm", "the owner still has to say yes");

  assert.deepEqual(await c.text("yes"), ["Your menu is updated ✅"]);
  assert.equal(joloState(c.space.id).updating, undefined);
});

test("more photos of the same menu join the open update", async () => {
  const c = chat(OWNER, await startStub());
  await onboard(c, "Barbara", "owner");
  await c.photo();
  assert.deepEqual(await c.photo(), [READING_MORE, "Is this your full menu, or just part of it?"]);
  await c.text("full");

  const [more, summary] = await c.photo();
  assert.equal(more, READING_MORE);
  assert.match(summary!, /^Found 2 new items/, "the agent merges the photo in and sends the summary again");
  assert.equal(joloState(c.space.id).pending, "confirm");
  assert.deepEqual(await c.text("no"), ["Okay, nothing changed. Send another photo whenever you're ready."]);

  assert.equal((await c.photo())[0], READING, "after the update closes, the next photo starts a new one");
});

test("the two reader failures have their own messages and keep the open question", async () => {
  const c = chat(OWNER, await startStub());
  await onboard(c, "Barbara", "owner");
  assert.deepEqual(await c.photo(undefined, "blurry.jpg"), [
    READING,
    "I couldn't read that photo. Can you send a clearer one?",
  ]);
  assert.equal(joloState(c.space.id).updating, undefined);
  assert.deepEqual(await c.photo(undefined, "offline.jpg"), [
    READING,
    "I can't read menus right now. Try again in a minute.",
  ]);

  await c.photo();
  assert.equal(joloState(c.space.id).pending, "scope");
  assert.deepEqual(await c.photo(undefined, "blurry.jpg"), [
    READING_MORE,
    "I couldn't read that photo. Can you send a clearer one?",
  ]);
  assert.equal(joloState(c.space.id).pending, "scope", "a bad extra photo doesn't lose the question");
  const [summary] = await c.text("part");
  assert.match(summary!, /^Found 2 new items/);
});

test("a HEIC that arrives unlabelled is still a photo, passed through byte for byte", async () => {
  const via = await startStub();
  const c = chat(OWNER, via);
  await onboard(c, "Barbara", "owner");
  const bytes = Buffer.concat([Buffer.from([0, 0, 0, 0x24]), Buffer.from("ftypheic"), Buffer.from("pixels")]);
  const before = c.sent.length;
  await respond(
    c.space,
    fakeMessage(c.space, {
      content: {
        type: "attachment",
        id: "a",
        name: "IMG_0042.HEIC",
        mimeType: "application/octet-stream",
        size: bytes.length,
        read: async () => bytes,
      },
      senderId: OWNER,
    }),
    "stream",
    { agent: via },
  );
  assert.deepEqual(c.sent.slice(before), [READING, "Is this your full menu, or just part of it?"]);
  const sentPhoto = requests.at(-1)!.event;
  assert.equal(sentPhoto.type === "message" && sentPhoto.photos[0]?.mime_type, "image/heic");
  assert.equal(sentPhoto.type === "message" && sentPhoto.photos[0]?.data_base64, bytes.toString("base64"));

  // A generic file that isn't an image is still refused.
  const after = c.sent.length;
  await respond(
    c.space,
    fakeMessage(c.space, {
      content: {
        type: "attachment",
        id: "b",
        name: "notes.bin",
        mimeType: "application/octet-stream",
        size: 20,
        read: async () => Buffer.from("just some text here!"),
      },
      senderId: OWNER,
    }),
    "stream",
    { agent: via },
  );
  assert.deepEqual(c.sent.slice(after), ["I can only read photos and text for now."]);
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
    READING,
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

// ---------- reviews ----------

const PROMPT = 'Let us know if you went to Barbara\'s, and want to leave a review. Reply "yes" or "no".';
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a customer who looked at a café is asked for a review once the delay is up", async () => {
  const c = chat("+12015550101", agent, 20);
  await onboard(c, "Sam", "customer");
  await c.text("what's on the menu at Barbara's?");
  assert.equal(joloState(c.space.id).review?.stage, "scheduled");
  await wait(80);
  assert.equal(c.sent.at(-1), PROMPT);
  assert.equal(joloState(c.space.id).review?.stage, "asked");

  assert.deepEqual(await c.text("yes!"), ["How would you rate Barbara's from 1 to 5?"]);
  assert.deepEqual(await c.text("hmm"), ['Reply with a number from 1 to 5, like "4".']);
  assert.deepEqual(await c.text("4 stars"), ['Thanks! What did you think? Reply "skip" to leave just the rating.']);
  assert.deepEqual(await c.text("Great cortado, a bit loud"), [
    "Thanks! Your review of Barbara's is on the Social tab in the JOLO app.",
  ]);
  assert.deepEqual(c.reviews, [
    { phone: "+12015550101", cafeId: "barbaras", cafeName: "Barbara's", rating: 4, comment: "Great cortado, a bit loud" },
  ]);
  assert.equal(joloState(c.space.id).review, undefined);

  // The same café is never asked about twice.
  await c.text("what's on the menu at Barbara's?");
  assert.equal(joloState(c.space.id).review, undefined);
});

test("a missed timer asks after the customer's next message, and a rating can carry the comment", async () => {
  const c = chat("+12015550102", agent, 0);
  await onboard(c, "Sam", "customer");
  const state = joloState(c.space.id);
  // Planned as if the bridge had restarted: due, with no timer running.
  state.review = { cafeId: "barbaras", cafeName: "Barbara's", stage: "scheduled", dueAt: new Date(0).toISOString() };
  const replies = await c.text("hi there");
  assert.equal(replies.at(-1), PROMPT);
  assert.deepEqual(await c.text("yes, 5 - perfect oat latte"), [
    "Thanks! Your review of Barbara's is on the Social tab in the JOLO app.",
  ]);
  assert.equal(c.reviews[0]?.rating, 5);
  assert.equal(c.reviews[0]?.comment, "perfect oat latte");
});

test("no ends the review, skip saves only the rating, and a failed save keeps the answer", async () => {
  const c = chat("+12015550103", agent, 0);
  await onboard(c, "Sam", "customer");
  const state = joloState(c.space.id);
  const due = () =>
    (state.review = { cafeId: "barbaras", cafeName: "Barbara's", stage: "asked", dueAt: new Date(0).toISOString() });

  due();
  assert.deepEqual(await c.text("no, didn't make it"), ["No problem. Enjoy your coffee ☕"]);
  assert.equal(c.reviews.length, 0);

  due();
  await c.text("yes");
  await c.text("3");
  c.failNextReview();
  assert.deepEqual(await c.text("skip"), [
    "I couldn't save your review just now. Send your comment again in a minute.",
  ]);
  c.failNextReview(false);
  await c.text("skip");
  assert.deepEqual(c.reviews, [{ phone: "+12015550103", cafeId: "barbaras", cafeName: "Barbara's", rating: 3, comment: "" }]);
});

test("an unrelated message during the question goes to the agent instead", async () => {
  const c = chat("+12015550104", agent, 0);
  await onboard(c, "Sam", "customer");
  const state = joloState(c.space.id);
  state.review = { cafeId: "barbaras", cafeName: "Barbara's", stage: "asked", dueAt: new Date(0).toISOString() };
  const before = requests.length;
  await c.text("where can I get matcha?");
  assert.equal(requests.length, before + 1);
  assert.equal(state.review, undefined);
});

test("owners are never asked for reviews", async () => {
  const c = chat(OWNER, agent, 0);
  await onboard(c, "Barbara", "owner");
  await c.text("what's on the menu at Barbara's?");
  assert.equal(joloState(c.space.id).review, undefined);
});
