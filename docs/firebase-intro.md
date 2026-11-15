# Firebase intro: setting up the JOLO database

A short guide for whoever creates the Firestore database. Full detail is in [`contracts.md`](contracts.md) §1 and [`deploy.md`](deploy.md); this is the quick version.

## What we need

- A Firebase project with **Firestore** on (project id used so far: `jolo-ec76d`). Use native mode, not Datastore mode.
- The app's rules and indexes: [`jolo-app/firestore.rules`](../jolo-app/firestore.rules) and [`jolo-app/firestore.indexes.json`](../jolo-app/firestore.indexes.json). Deploy them, don't write new ones.
- A **service-account key** (Firebase console → Project settings → Service accounts → Generate new private key) for the agent backend. Send it privately. **Never commit it**; `.gitignore` already blocks `serviceAccount*.json`.

## Try it locally first (no key, no cloud)

```bash
cd jolo-app
npm install
npm run emulators      # Firestore on :8080, emulator UI on :4000
```

Point the agent at it with `FIRESTORE_EMULATOR_HOST=localhost:8080`. Do this before touching the real project.

## The data

```
cafes/{cafeId}
    name, address, location {lat, lng}, hours, phone        the app's own fields
    ownerPhone            E.164, e.g. +19085551234; admin only, clients never write it
    currentMenuVersion    0 = no menu yet
    menuUpdatedAt         Timestamp
    vibe, summary         optional one-liners used by search
cafes/{cafeId}/menuVersions/{n}     immutable; a change creates n+1
    items[]               the WHOLE menu: item, category, prices[{size, usd}], id, available, confidence
    source                "imessage" | "app"
    createdAt, createdBy
cafes/{cafeId}/insights/{weekStart}  weekly counts (owner read only)
agentUsers, agentDrafts, agentCorrections, agentEvents    the agent's own data; rules deny every client
```

- Prices are dollars as numbers (`usd: 4.75`). A missing price stays empty; never invent one.
- Hours: `{"mon": ["07:00","15:00"]}`; no key = closed; a close time before open means after midnight.

## Putting the real Princeton cafés in

15 real cafés from OpenStreetMap are in [`data/cafes_osm.yaml`](../data/cafes_osm.yaml): names, coordinates, most addresses, **no menus** (owners add those by texting a photo).

`scripts/push_cafes_firestore.py` writes them into the app's existing `cafes` collection in the **same shape as the app's own OSM import** (`jolo-app/scripts/seed-cafes.mjs`): id `osm-node-<id>`, `osmId`, `nameLower`, `municipality`, `amenities`, `hours` as `[{open, close}]` per day, a GeoPoint `location`, and zeroed counters.

```bash
# 1. Try it on the emulator (needs Java; `npm run emulators` in jolo-app)
FIRESTORE_EMULATOR_HOST=localhost:8080 python scripts/push_cafes_firestore.py --write

# 2. Dry run against the real project (reads, writes nothing)
GOOGLE_APPLICATION_CREDENTIALS=<key.json> python scripts/push_cafes_firestore.py

# 3. The real write
GOOGLE_APPLICATION_CREDENTIALS=<key.json> python scripts/push_cafes_firestore.py --write --really-write-to-firestore
```

- A café is skipped if a document with that id **or the same `osmId`** already exists, so it is safe to run twice or after the app's import. Existing documents are never modified.
- It never sets `ownerPhone`; use `npm run link-owner` in `jolo-app` for that.
- Hours are missing for most of the 15 (OpenStreetMap has none). Fill them in by hand for the cafés you will show.

## Do not

- **Do not run `scripts/seed_store.py` on the real project.** It writes 22 *invented* cafés. It refuses unless forced.
- Do not commit `.env` or any `*.json` key.
- Do not set `ownerPhone` from the app; use an admin script.

## Environment variables

| Variable | Use |
|---|---|
| `GOOGLE_APPLICATION_CREDENTIALS` | path to the service-account key |
| `FIRESTORE_EMULATOR_HOST` | `localhost:8080` to use the emulator instead |
| `AGENT_TOKEN` | bearer token the bridge sends to the agent |
| `JOLO_PHONE_SALT` | salt for phone hashes; set once, never change it |

## Checklist

- [ ] Firestore created (native mode)
- [ ] Rules and indexes deployed from `jolo-app/`
- [ ] Service-account key shared privately
- [ ] Tried on the emulator
- [ ] Real cafés loaded with `--really-write-to-firestore`
- [ ] One café's `ownerPhone` set, and one test menu sent end to end
