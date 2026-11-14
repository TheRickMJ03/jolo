// Runs against the Firestore emulator; see jest.rules.config.js and
// `npm run test:rules` (needs Java 21+).
const fs = require("node:fs");
const path = require("node:path");
const {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} = require("@firebase/rules-unit-testing");
const {
  deleteDoc,
  doc,
  getDoc,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
} = require("firebase/firestore");

const OWNER_PHONE = "+19085551234";
let testEnv;

const asGuest = () => testEnv.unauthenticatedContext().firestore();
const asUser = (uid) => testEnv.authenticatedContext(uid).firestore();
// Phone Auth puts the verified number in the ID token as phone_number.
const asPhone = (uid, phone) =>
  testEnv.authenticatedContext(uid, { phone_number: phone }).firestore();
const asOwner = () => asPhone("owner", OWNER_PHONE);

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: "demo-jolo",
    firestore: {
      rules: fs.readFileSync(path.join(__dirname, "../../firestore.rules"), "utf8"),
    },
  });
});

afterAll(() => testEnv.cleanup());

beforeEach(async () => {
  await testEnv.clearFirestore();
  // Seed data as the Admin SDK would, bypassing the rules.
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, "cafes/cafe1"), {
      name: "Barbara's",
      ownerPhone: OWNER_PHONE,
      currentMenuVersion: 3,
    });
    await setDoc(doc(db, "cafes/cafe1/menuVersions/3"), { version: 3, items: [] });
    await setDoc(doc(db, "cafes/cafe1/insights/2026-11-09"), {
      weekStart: "2026-11-09",
      counts: {},
    });
    await setDoc(doc(db, "cafes/cafe2"), { name: "Someone else's", ownerPhone: "+12015550000" });
    await setDoc(doc(db, "users/alice"), { displayName: "Alice" });
    await setDoc(doc(db, "users/alice/private/account"), { email: "alice@example.com" });
  });
});

/** The write the app makes: version N+1 and the pointer, together. */
function saveVersion(
  db,
  { version = 4, pointer = version, uid = "owner", phone = OWNER_PHONE, extra = {} } = {},
) {
  const batch = writeBatch(db);
  batch.set(doc(db, `cafes/cafe1/menuVersions/${version}`), {
    version,
    basedOn: version - 1,
    scope: "full",
    source: "app",
    createdAt: serverTimestamp(),
    createdBy: { uid, phone },
    items: [
      {
        id: "cortado",
        section: "Coffee",
        item: "Cortado",
        category: "drink",
        prices: [{ size: null, usd: 4.75 }],
        confidence: 1,
        available: true,
      },
    ],
    changes: { added: [], price_changes: [], changed: [], removed: [] },
    ...extra,
  });
  batch.update(doc(db, "cafes/cafe1"), {
    currentMenuVersion: pointer,
    menuUpdatedAt: serverTimestamp(),
  });
  return batch.commit();
}

describe("cafes", () => {
  it("can be read by anyone, signed in or not", async () => {
    await assertSucceeds(getDoc(doc(asGuest(), "cafes/cafe1")));
    await assertSucceeds(getDoc(doc(asUser("alice"), "cafes/cafe1")));
  });

  it("cannot be created, renamed or deleted from the app, even by the owner", async () => {
    await assertFails(setDoc(doc(asUser("alice"), "cafes/new"), { name: "Fake Café" }));
    await assertFails(updateDoc(doc(asOwner(), "cafes/cafe1"), { name: "Renamed" }));
    await assertFails(deleteDoc(doc(asOwner(), "cafes/cafe1")));
  });

  it("never lets the owner change ownerPhone", async () => {
    await assertFails(updateDoc(doc(asOwner(), "cafes/cafe1"), { ownerPhone: "+15550000000" }));
  });

  it("cannot have its menu pointer moved without a matching new version", async () => {
    await assertFails(
      updateDoc(doc(asOwner(), "cafes/cafe1"), {
        currentMenuVersion: 4,
        menuUpdatedAt: serverTimestamp(),
      }),
    );
  });
});

describe("menuVersions", () => {
  it("are public to read", async () => {
    await assertSucceeds(getDoc(doc(asGuest(), "cafes/cafe1/menuVersions/3")));
  });

  it("the owner can save version N+1 together with the pointer", async () => {
    await assertSucceeds(saveVersion(asOwner()));
  });

  it("can't skip a version or leave the pointer behind", async () => {
    await assertFails(saveVersion(asOwner(), { version: 5 }));
    await assertFails(saveVersion(asOwner(), { version: 4, pointer: 5 }));
    // Version doc alone, pointer untouched:
    await assertFails(
      setDoc(doc(asOwner(), "cafes/cafe1/menuVersions/4"), {
        version: 4,
        basedOn: 3,
        scope: "full",
        source: "app",
        createdAt: serverTimestamp(),
        createdBy: { uid: "owner", phone: OWNER_PHONE },
        items: [],
        changes: {},
      }),
    );
  });

  it("rejects a version that misstates who made it or where it came from", async () => {
    await assertFails(saveVersion(asOwner(), { uid: "someone-else" }));
    await assertFails(saveVersion(asOwner(), { phone: "+12015550000" }));
    await assertFails(saveVersion(asOwner(), { extra: { source: "imessage" } }));
    await assertFails(saveVersion(asOwner(), { extra: { surprise: true } }));
  });

  it("can't be written by anyone who isn't the owner", async () => {
    await assertFails(
      saveVersion(asPhone("mallory", "+15550000000"), { uid: "mallory", phone: "+15550000000" }),
    );
    // An email account has no verified phone, whatever it claims.
    await assertFails(saveVersion(asUser("alice"), { uid: "alice" }));
    await assertFails(saveVersion(asGuest(), { uid: null, phone: null }));
  });

  it("are immutable: no edits, no deletes", async () => {
    await assertFails(updateDoc(doc(asOwner(), "cafes/cafe1/menuVersions/3"), { items: [] }));
    await assertFails(deleteDoc(doc(asOwner(), "cafes/cafe1/menuVersions/3")));
  });

  it("an owner of one café can't write another's menu", async () => {
    const otherOwner = asPhone("other", "+12015550000");
    const batch = writeBatch(otherOwner);
    batch.set(doc(otherOwner, "cafes/cafe1/menuVersions/4"), { version: 4 });
    batch.update(doc(otherOwner, "cafes/cafe1"), {
      currentMenuVersion: 4,
      menuUpdatedAt: serverTimestamp(),
    });
    await assertFails(batch.commit());
  });
});

describe("insights", () => {
  it("are readable only by the café's owner", async () => {
    await assertSucceeds(getDoc(doc(asOwner(), "cafes/cafe1/insights/2026-11-09")));
    await assertFails(getDoc(doc(asGuest(), "cafes/cafe1/insights/2026-11-09")));
    await assertFails(getDoc(doc(asUser("alice"), "cafes/cafe1/insights/2026-11-09")));
    await assertFails(
      getDoc(doc(asPhone("other", "+12015550000"), "cafes/cafe1/insights/2026-11-09")),
    );
  });

  it("can't be written from the app", async () => {
    await assertFails(setDoc(doc(asOwner(), "cafes/cafe1/insights/2026-11-16"), { counts: {} }));
  });
});

// Unchanged from the JOLO app: these rules are shared by both apps.
describe("users", () => {
  it("are hidden from signed-out visitors", async () => {
    await assertFails(getDoc(doc(asGuest(), "users/alice")));
  });

  it("can be read by any signed-in user", async () => {
    await assertSucceeds(getDoc(doc(asUser("bob"), "users/alice")));
  });

  it("can only be created and updated by their owner", async () => {
    await assertSucceeds(setDoc(doc(asUser("bob"), "users/bob"), { displayName: "Bob" }));
    await assertSucceeds(setDoc(doc(asUser("alice"), "users/alice"), { displayName: "Al" }));
    await assertFails(setDoc(doc(asUser("bob"), "users/alice"), { displayName: "Hacked" }));
  });

  it("cannot be deleted from the app", async () => {
    await assertFails(deleteDoc(doc(asUser("alice"), "users/alice")));
  });

  it("private docs are readable and writable only by the owner", async () => {
    const own = doc(asUser("alice"), "users/alice/private/account");
    await assertSucceeds(getDoc(own));
    await assertSucceeds(setDoc(own, { email: "new@example.com" }));
    const other = doc(asUser("bob"), "users/alice/private/account");
    await assertFails(getDoc(other));
    await assertFails(setDoc(other, { email: "bob@example.com" }));
  });
});

describe("everything else", () => {
  it("is locked", async () => {
    await assertFails(getDoc(doc(asOwner(), "secrets/anything")));
    await assertFails(setDoc(doc(asOwner(), "secrets/anything"), { x: 1 }));
  });
});
