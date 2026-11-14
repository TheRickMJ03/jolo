import "./setup.ts";

import assert from "node:assert/strict";
import { test } from "node:test";

import { parseActions } from "../src/jolo/agent-client.ts";
import { confirmSummary, formatPrice, formatPrices } from "../src/jolo/copy.ts";
import { parseConfirm, parseConfirmReply, parseName, parseRole, parseScope } from "../src/jolo/parse.ts";

test("scope answers", () => {
  for (const text of ["Just part of it", "partial", "only the drinks", "some of it", "half"]) {
    assert.equal(parseScope(text), "partial", text);
  }
  for (const text of ["full", "the whole thing", "All of it", "everything", "complete menu"]) {
    assert.equal(parseScope(text), "full", text);
  }
  for (const text of ["", "hmm", "maybe", "part of it, no wait, all of it"]) {
    assert.equal(parseScope(text), null, text);
  }
});

test("yes/no answers", () => {
  for (const text of ["Yes, all correct", "yep", "Y", "looks good", "👍", "ok"]) assert.equal(parseConfirm(text), true, text);
  for (const text of ["no", "Nope", "that's wrong", "cancel", "👎", "not correct", "don't"]) {
    assert.equal(parseConfirm(text), false, text);
  }
  for (const text of ["", "hmm", "maybe?", "yes but no", "yes, but not the croissant"]) {
    assert.equal(parseConfirm(text), null, text);
  }
});

test("roles", () => {
  for (const text of ["owner", "I own a café", "Café owner", "I run it", "1"]) assert.equal(parseRole(text), "owner", text);
  for (const text of ["customer", "just looking", "guest", "2"]) assert.equal(parseRole(text), "customer", text);
  for (const text of ["", "who's asking", "owner and customer"]) assert.equal(parseRole(text), null, text);
});

test("names", () => {
  assert.equal(parseName("Barbara"), "Barbara");
  assert.equal(parseName("i'm barbara!"), "Barbara");
  assert.equal(parseName("Hi, my name is Ana Lucía."), "Ana Lucía");
  assert.equal(parseName("call me Sam"), "Sam");
  assert.equal(parseName(""), null);
  assert.equal(parseName("123"), null);
  assert.equal(parseName("what is this thing and who made it"), null);
  assert.equal(parseName("x".repeat(41)), null);
});

test("summary headline matches the sequence diagram", () => {
  const summary = confirmSummary({
    added: [
      { item: "Oat Latte", prices: [{ usd: 5 }], confidence: 0.9 },
      { item: "Matcha", prices: [], confidence: 0.4 },
    ],
    price_changes: [
      { item: "Cortado", old_usd: 4.5, new_usd: 4.75 },
      { item: "Latte", size: "16 oz", old_usd: 4.25, new_usd: 4.5 },
      { item: "Muffin", old_usd: 3, new_usd: 3.25 },
    ],
    removed: [],
  });
  const lines = summary!.split("\n");
  assert.equal(lines[0], "Found 2 new items and 3 price changes. Cortado now $4.75?");
  assert.equal(lines[1], "+ Matcha no price", "the least confident new item is listed first");
  assert.equal(lines[2], "+ Oat Latte $5.00");
  assert.match(summary!, /• Latte \(16 oz\) \$4\.25 → \$4\.50/);

  const single = confirmSummary({ added: [], price_changes: [], removed: ["Croissant"] });
  assert.equal(single?.split("\n")[0], "Found 1 removed item.");

  assert.equal(confirmSummary({ added: [], price_changes: [], removed: [] }), null);

  const many = confirmSummary({
    added: Array.from({ length: 9 }, (_, i) => ({ item: `Item ${i}`, prices: [{ usd: 1 }] })),
    price_changes: [],
    removed: [],
  });
  assert.match(many!, /…and 3 more/);
});

test("a first menu asks about the least confident item; sizes are shown", () => {
  const first = confirmSummary({
    added: [
      { item: "Espresso", prices: [{ usd: 3 }], confidence: 1 },
      {
        item: "Latte",
        prices: [
          { size: "12 oz", usd: 3.5 },
          { size: "16 oz", usd: 4.25 },
        ],
        confidence: 0.5,
      },
    ],
    price_changes: [],
    removed: [],
  });
  assert.equal(first?.split("\n")[0], "Found 2 new items. Latte 12 oz $3.50 / 16 oz $4.25?");

  const sizes = confirmSummary({
    added: [],
    price_changes: [
      { item: "Latte", size: "20 oz", old_usd: null, new_usd: 5 },
      { item: "Latte", size: "8 oz", old_usd: 3, new_usd: null },
    ],
    removed: [],
  });
  assert.match(sizes!, /• Latte \(20 oz\) new at \$5\.00/);
  assert.match(sizes!, /• Latte \(8 oz\) \$3\.00 → no longer listed/);
});

test("prices", () => {
  assert.equal(formatPrice(4.75), "$4.75");
  assert.equal(formatPrice(0), "$0.00");
  assert.equal(formatPrice(null), "no price");
  assert.equal(formatPrices([]), "no price");
});

test("a reply to the summary with a fix in it is a correction, never a yes or no", () => {
  for (const text of ["no, the cortado is 4.50", "yes but the small is 12 oz", "yes, but not the croissant", "rename matcha to matcha latte"]) {
    assert.equal(parseConfirmReply(text), "correction", text);
  }
  assert.equal(parseConfirmReply("Yes, all correct"), true);
  assert.equal(parseConfirmReply("not correct"), false);
  assert.equal(parseConfirmReply("maybe?"), null);
});

test("agent responses are validated; unknown actions are ignored", () => {
  assert.deepEqual(parseActions({ actions: [{ type: "say", text: "hi" }, { type: "future_thing" }] }), [
    { type: "say", text: "hi" },
  ]);
  assert.throws(() => parseActions({}), /no actions/);
  assert.throws(() => parseActions({ actions: [{ type: "say" }] }), /say without text/);
  assert.throws(
    () => parseActions({ actions: [{ type: "confirm_changes", changes: { added: [{}], price_changes: [], removed: [] } }] }),
    /malformed/,
  );
  assert.deepEqual(
    parseActions({ actions: [{ type: "unreadable_photo", reason: "blurry" }, { type: "reader_down" }] }),
    [{ type: "unreadable_photo", reason: "blurry" }, { type: "reader_down" }],
  );
});
