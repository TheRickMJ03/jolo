// `npm run seed:trends-demo` — demo data for Insights and Social, in the LOCAL
// Firestore emulator only. Run `npm run seed:cafes` first.
//
//   - menus with history for six Union County cafés, so "Other shops" and
//     "Trending near you" have drinks that were added this month
//   - searches and drink taps from four made-up customers (demo-customer-*)
//   - with OWNER_CAFE_ID set: a menu and two weeks of insights for that café,
//     so its owner sees the whole Insights hub
//
// Then run the recommend job: python -m recommend.job --analytics --demo-trends
//
//   FIRESTORE_EMULATOR_HOST=127.0.0.1:18180 OWNER_CAFE_ID=owner-19085905037 npm run seed:trends-demo
import { initializeApp } from "firebase-admin/app";
import { FieldValue, Timestamp, getFirestore } from "firebase-admin/firestore";

const host = process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080";
process.env.FIRESTORE_EMULATOR_HOST = host;
const projectId = process.env.FIRESTORE_PROJECT_ID ?? "jolo-ec76d";
const ownerCafeId = process.env.OWNER_CAFE_ID;

initializeApp({ projectId });
const db = getFirestore();
const daysAgo = (days) => Timestamp.fromDate(new Date(Date.now() - days * 86_400_000));

const item = (name, category, usd, extra = {}) => ({
  id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
  section: category === "drink" ? "Coffee" : "Bakery",
  item: name,
  category,
  prices: [{ size: null, usd }],
  add_ons: [],
  variants: [],
  tags: [],
  confidence: 1,
  available: true,
  ...extra,
});

const BASE = [
  item("Espresso", "drink", 3),
  item("Cortado", "drink", 4.5),
  item("Latte", "drink", 4.25),
  item("Cappuccino", "drink", 4.25),
  item("Cold Brew", "drink", 4.75),
  item("Croissant", "food", 3.75),
];
const LAVENDER = item("Lavender Oat Latte", "drink", 5.75);
const MATCHA = item("Iced Matcha Latte", "drink", 5.5);
const SHAKEN = item("Brown Sugar Oat Shaken Espresso", "drink", 6);

// [café id, name, days since the new drinks went on, drinks added]
const CAFES = [
  ["osm-node-13858905801", "Black Drop Coffee", 3, [LAVENDER, MATCHA]],
  ["osm-node-12604550736", "Ayala Coffee", 5, [LAVENDER]],
  ["osm-node-3838252749", "& Grain", 9, [MATCHA, SHAKEN]],
  ["osm-node-1978352936", "Rockn' Joe", 2, [LAVENDER]],
  ["osm-node-2609751514", "Boxwood Cafe", 12, []],
  ["osm-node-13811269295", "Coffee Culture Roastery", 20, []],
];

const version = (number, at, items, added = [], priceChanges = []) => ({
  version: number,
  basedOn: number - 1,
  scope: "full",
  source: "imessage",
  createdAt: daysAgo(at),
  createdBy: { phone: null, uid: null },
  items,
  changes: {
    added: added.map((row) => row.item),
    price_changes: priceChanges,
    changed: [],
    removed: [],
  },
});

let batch = db.batch();
for (const [id, name, days, added] of CAFES) {
  const cafe = db.doc(`cafes/${id}`);
  const snapshot = await cafe.get();
  if (!snapshot.exists) {
    console.error(`cafes/${id} (${name}) is missing. Run npm run seed:cafes first.`);
    process.exit(1);
  }
  batch.set(cafe.collection("menuVersions").doc("1"), version(1, 45, BASE));
  batch.set(cafe.collection("menuVersions").doc("2"), version(2, days, [...BASE, ...added], added));
  batch.update(cafe, { currentMenuVersion: 2, menuUpdatedAt: daysAgo(days) });
}

const PEOPLE = {
  "demo-customer-1": [
    ["search", { text: "oat milk latte" }, 1],
    ["search", { text: "lavender latte" }, 2],
    ["open", { cafeId: CAFES[0][0], itemId: LAVENDER.id, itemName: LAVENDER.item }, 1],
  ],
  "demo-customer-2": [
    ["search", { text: "iced matcha" }, 3],
    ["save", { cafeId: CAFES[2][0], itemId: MATCHA.id, itemName: MATCHA.item }, 2],
  ],
  "demo-customer-3": [
    ["search", { text: "mocha" }, 4],
    ["search", { text: "iced matcha latte" }, 1],
  ],
  "demo-customer-4": [
    ["search", { text: "lavender oat latte" }, 1],
    ["search", { text: "mocha" }, 6],
    ["purchase", { cafeId: CAFES[3][0], itemId: "cortado", itemName: "Cortado" }, 5],
  ],
};
for (const [uid, events] of Object.entries(PEOPLE)) {
  batch.set(db.doc(`users/${uid}`), { displayName: "Demo customer", demo: true });
  events.forEach(([type, fields, at], index) => {
    batch.set(db.doc(`users/${uid}/events/demo-${index}`), {
      type,
      ...fields,
      createdAt: daysAgo(at),
    });
  });
}

if (ownerCafeId) {
  const cafe = db.doc(`cafes/${ownerCafeId}`);
  if (!(await cafe.get()).exists) {
    console.error(`cafes/${ownerCafeId} is missing. Onboard the owner over iMessage first.`);
    process.exit(1);
  }
  const v1 = [
    ...BASE.slice(0, 4),
    item("Mocha", "drink", 5),
    item("Chai Latte", "drink", 4.75, { confidence: 0.4 }),
    item("Muffin", "food", 3.25),
  ];
  const v2 = v1.map((row) => {
    if (row.id === "cortado") return { ...row, prices: [{ size: null, usd: 4.75 }] };
    if (row.id === "mocha") return { ...row, available: false };
    return row;
  });
  batch.set(cafe.collection("menuVersions").doc("1"), version(1, 40, v1));
  batch.set(
    cafe.collection("menuVersions").doc("2"),
    version(2, 6, v2, [], [{ item: "Cortado", size: null, old_usd: 4.5, new_usd: 4.75 }]),
  );
  batch.update(cafe, { currentMenuVersion: 2, menuUpdatedAt: daysAgo(6) });
  batch.set(cafe.collection("insights").doc("2026-11-02"), {
    weekStart: "2026-11-02",
    counts: { customerQuestions: 14, uniqueCustomers: 8, menuUpdates: 0 },
    topItems: [
      { name: "Latte", mentions: 5 },
      { name: "Mocha", mentions: 3 },
    ],
    summary: "A quiet week. Most questions were about lattes.",
    generatedAt: FieldValue.serverTimestamp(),
  });
  batch.set(cafe.collection("insights").doc("2026-11-09"), {
    weekStart: "2026-11-09",
    counts: { customerQuestions: 31, uniqueCustomers: 15, menuUpdates: 1 },
    topItems: [
      { name: "Cortado", mentions: 8 },
      { name: "Mocha", mentions: 6 },
      { name: "Latte", mentions: 4 },
    ],
    summary:
      "Questions doubled after the menu update. Six people asked about the mocha, which is sold out.",
    generatedAt: FieldValue.serverTimestamp(),
  });
}

await batch.commit();
console.log(
  `Seeded ${CAFES.length} café menus and ${Object.keys(PEOPLE).length} demo customers into ${projectId} at ${host}` +
    (ownerCafeId ? `, plus a menu and insights for ${ownerCafeId}.` : "."),
);
