import "./setup.ts";

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  cafeIdFor,
  type CafeFields,
  linkViaEmulator,
  linkWith,
  mergeCafe,
  toE164,
} from "../src/jolo/link-cafe.ts";

const PROFILE = { name: "Zay", businessName: "cafe g", location: "princeton", phone: "+19085905037" };

test("toE164 and the café id", () => {
  assert.equal(toE164("(908) 590-5037"), "+19085905037");
  assert.equal(toE164("+44 20 7946 0958"), "+442079460958");
  assert.equal(toE164("555"), null);
  assert.equal(cafeIdFor("+19085905037"), "owner-19085905037");
});

test("a new café starts with no menu", () => {
  assert.deepEqual(mergeCafe(null, PROFILE), {
    name: "cafe g",
    ownerName: "Zay",
    address: "princeton",
    ownerPhone: "+19085905037",
    phone: "+19085905037",
    source: "imessage",
    currentMenuVersion: 0,
  });
});

test("signing up again keeps the menu pointer and everything else", () => {
  const existing = { name: "old", currentMenuVersion: 4, menuUpdatedAt: "ts", municipality: "Westfield", source: "osm" };
  const merged = mergeCafe(existing, { ...PROFILE, businessName: "cafe g2" });
  assert.equal(merged.name, "cafe g2");
  assert.equal(merged.currentMenuVersion, 4);
  assert.equal(merged.menuUpdatedAt, "ts");
  assert.equal(merged.municipality, "Westfield");
  assert.equal(merged.source, "osm");
});

test("the Admin path writes only the sign-up's fields, merged", async () => {
  const writes: [string, CafeFields][] = [];
  await linkWith(
    {
      read: async () => ({ currentMenuVersion: 2, hours: { mo: [] } }),
      write: async (id, fields) => {
        writes.push([id, fields]);
      },
    },
    PROFILE,
  );
  assert.equal(writes.length, 1);
  const [id, fields] = writes[0]!;
  assert.equal(id, "owner-19085905037");
  assert.equal(fields.currentMenuVersion, 2, "kept, not reset");
  assert.equal("hours" in fields, false, "untouched fields aren't rewritten");
});

test("the emulator path reads first and carries every field over", async () => {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  const request = (async (url: string, init: RequestInit = {}) => {
    calls.push({ method: init.method ?? "GET", url, body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (!init.method) {
      return new Response(
        JSON.stringify({
          fields: {
            name: { stringValue: "old" },
            currentMenuVersion: { integerValue: "3" },
            menuUpdatedAt: { timestampValue: "2026-11-14T12:00:00Z" },
          },
        }),
        { status: 200 },
      );
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  await linkViaEmulator(PROFILE, "127.0.0.1:18180", "jolo-ec76d", request);

  assert.deepEqual(
    calls.map((call) => call.method),
    ["GET", "DELETE", "POST"],
  );
  const fields = (calls[2]!.body as { fields: Record<string, unknown> }).fields;
  assert.deepEqual(fields.currentMenuVersion, { integerValue: "3" });
  assert.deepEqual(fields.menuUpdatedAt, { timestampValue: "2026-11-14T12:00:00Z" });
  assert.deepEqual(fields.name, { stringValue: "cafe g" });
});

test("the emulator path creates a café that doesn't exist yet", async () => {
  const methods: string[] = [];
  const request = (async (_url: string, init: RequestInit = {}) => {
    methods.push(init.method ?? "GET");
    return init.method ? new Response("{}", { status: 200 }) : new Response("not found", { status: 404 });
  }) as typeof fetch;
  await linkViaEmulator(PROFILE, "127.0.0.1:18180", "jolo-ec76d", request);
  assert.deepEqual(methods, ["GET", "POST"]);
});
