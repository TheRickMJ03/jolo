import "./setup.ts";

import assert from "node:assert/strict";
import { test } from "node:test";

import { askFromCustomerMessage, saveCustomerAsk } from "../src/jolo/customer-asks.ts";

test("a customer's question is kept, and onboarding and owners are not", () => {
  assert.deepEqual(
    askFromCustomerMessage("customer", "message", "  chai tea  ", "+1 (908) 555-1234"),
    { phone: "+19085551234", text: "chai tea" },
  );
  assert.equal(askFromCustomerMessage(undefined, "message", "user", "+12015550000"), null);
  assert.equal(askFromCustomerMessage("owner", "message", "the cortado is 4.50", "+19085551234"), null);
  assert.equal(askFromCustomerMessage("customer", "confirm", "yes", "+12015550000"), null);
  assert.equal(askFromCustomerMessage("customer", "message", "   ", "+12015550000"), null);
});

test("an existing app account gets the ask on their event log", async () => {
  const saved: { uid?: string; phone?: string; text: string }[] = [];
  await saveCustomerAsk(
    {
      async userId() {
        return "uid-1";
      },
      async saveForUser(uid, text) {
        saved.push({ uid, text });
      },
      async saveForPhone(phone, text) {
        saved.push({ phone, text });
      },
    },
    "+12015550001",
    "chai tea",
  );
  assert.deepEqual(saved, [{ uid: "uid-1", text: "chai tea" }]);
});

test("a number with no app account waits under that phone", async () => {
  const saved: { phone?: string; text: string }[] = [];
  await saveCustomerAsk(
    {
      async userId() {
        return null;
      },
      async saveForUser() {
        throw new Error("no account");
      },
      async saveForPhone(phone, text) {
        saved.push({ phone, text });
      },
    },
    "+12015550001",
    "chai tea",
  );
  assert.deepEqual(saved, [{ phone: "+12015550001", text: "chai tea" }]);
});
