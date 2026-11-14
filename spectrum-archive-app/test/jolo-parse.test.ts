import "./setup.ts";

import assert from "node:assert/strict";
import { test } from "node:test";

import { parseActions } from "../src/jolo/agent-client.ts";
import { confirmSummary, formatPrice } from "../src/jolo/copy.ts";
import { parseConfirm, parseName, parseRole, parseScope } from "../src/jolo/parse.ts";

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
      { name: "Oat Latte", priceCents: 500 },
      { name: "Matcha", priceCents: null },
    ],
    changed: [
      { name: "Cortado", field: "priceCents", from: 450, to: 475 },
      { name: "Latte", field: "priceCents", from: 325, to: 350 },
      { name: "Muffin", field: "priceCents", from: 300, to: 325 },
    ],
    removed: [],
  });
  assert.equal(summary?.split("\n")[0], "Found 2 new items and 3 price changes. Cortado now $4.75?");
  assert.match(summary!, /\+ Matcha no price/);

  const single = confirmSummary({ added: [], changed: [], removed: [{ name: "Croissant" }] });
  assert.equal(single?.split("\n")[0], "Found 1 removed item.");

  const rename = confirmSummary({
    added: [],
    changed: [{ name: "Muffin", field: "name", from: "Muffin", to: "Blueberry Muffin" }],
    removed: [],
  });
  assert.match(rename!, /• Muffin: "Muffin" → "Blueberry Muffin"/);

  assert.equal(confirmSummary({ added: [], changed: [], removed: [] }), null);

  const many = confirmSummary({
    added: Array.from({ length: 9 }, (_, i) => ({ name: `Item ${i}`, priceCents: 100 })),
    changed: [],
    removed: [],
  });
  assert.match(many!, /…and 3 more/);
});

test("prices", () => {
  assert.equal(formatPrice(475), "$4.75");
  assert.equal(formatPrice(0), "$0.00");
  assert.equal(formatPrice(null), "no price");
});

test("agent responses are validated; unknown actions are ignored", () => {
  assert.deepEqual(parseActions({ actions: [{ type: "say", text: "hi" }, { type: "future_thing" }] }), [
    { type: "say", text: "hi" },
  ]);
  assert.throws(() => parseActions({}), /no actions/);
  assert.throws(() => parseActions({ actions: [{ type: "say" }] }), /say without text/);
  assert.throws(
    () => parseActions({ actions: [{ type: "confirm_changes", changes: { added: [{}], changed: [], removed: [] } }] }),
    /malformed/,
  );
});
