# Running the brain in Docker

Works on Windows, Intel Mac and Apple Silicon Mac (Paddle and PyTorch have arm64 Linux wheels).

## One-time setup

1. Install Docker Desktop and start it.
2. `cp .env.example .env`, then fill in `AGENT_TOKEN` and `JOLO_PHONE_SALT` (see the comments inside).
3. Open the tunnel to the model VM and leave it running (the container reaches it as `host.docker.internal:8000`):
   ```bash
   ssh -i <your key>.pem -N -L 0.0.0.0:8000:localhost:8000 ubuntu@<VM IP>
   ```

## Build and start

```bash
docker compose up -d --build
docker compose logs -f          # first start: seeds the store, downloads ~1.2 GB of search models, builds the index
```

The first start takes about 10 minutes. After that it is seconds. The store and index live in `./data` (git-ignored); the models in a Docker volume.

## Check it

The API is on host port **8090** (inside the container it is 8080), because 8080 is often taken by the Firestore emulator. To change it, edit `ports:` in `docker-compose.yml`.

```bash
curl -H "Authorization: Bearer $AGENT_TOKEN" http://localhost:8090/health
```

You want `"model_server": true`. `false` means the tunnel is down.

Point the iMessage bridge at it: `AGENT_URL=http://localhost:8090` and the same `AGENT_TOKEN`.

## What is in the store

22 invented demo cafés (with menus) plus 15 real Princeton cafés from OpenStreetMap (`data/cafes_osm.yaml`, no menus: "menu coming soon"). Owners add menus by texting a photo. To act as a café's owner from your own phone:

```bash
docker compose exec jolo python scripts/seed_store.py --owner +1YOURNUMBER=small_world_coffee
```

Café ids are the keys in `data/cafes_osm.yaml`. Never use `--reset` unless you mean to wipe the store.

## Everyday commands

```bash
docker compose restart          # after changing data/ files
docker compose down             # stop (data stays)
rm -rf data/store.json data/index && docker compose up -d   # start from a fresh store
```

Rebuild with `--build` after pulling code changes. Edits to files in `data/` do not need a rebuild, because `./data` is mounted.

## Against the shared Firestore database (jolo-ec76d)

The default start uses a local JSON store with invented demo cafés. To use the real database (the same cafés the app shows) add the override file:

```bash
# .env: FIREBASE_KEY_FILE=/full/path/to/the-service-account-key.json   (never commit the key)
docker compose -f docker-compose.yml -f docker-compose.firestore.yml up -d --build
```

- The container does **not** seed anything in this mode. `GET /health` should show `"store": "firestore"` and the café count from the database (Union County + the 15 Princeton cafés = 86 at the time of writing).
- The search index is built from Firestore on the first start (a few minutes: it downloads ~1.2 GB of models).
- Switch back to the local store: `docker compose down`, then `docker compose up -d` (without the second file).

## Test with the iMessage bridge (Isaiah's Mac)

1. Start the tunnel and the container as above. `curl -H "Authorization: Bearer $AGENT_TOKEN" http://localhost:8090/health` must say `"model_server": true`.
2. In `spectrum-archive-app/.env`: `AGENT_URL=http://localhost:8090` and `AGENT_TOKEN=` the same value as the container's.
3. Make a phone the owner of a café (Admin SDK, dry run first):
   ```bash
   cd jolo-app
   npm run link-owner -- --service-account <key.json> --cafe osm-node-4827959907 --phone "<number>"     # Junbi; add --yes to apply
   ```
4. `npm start` in `spectrum-archive-app`, then text from that phone.

What to try:

| Test | What you should see |
|---|---|
| Customer: "tell me about Junbi" | A real café from the database, no invented menu items |
| Customer: "where can I get a cortado?" | Only cafés with a menu; a café without one is "menu coming soon" |
| Customer: "coffee near Palmer Square" | Real Princeton cafés, nearest first |
| Owner: send a menu photo | "Reading your menu…", then a full or partial question |
| Owner: answer "full", correct an item, then say yes | `menuVersions/1` appears under the café in the console, `currentMenuVersion: 1` |
| Owner: send a second photo with one price changed | `menuVersions/2` with `changes.price_changes`; version 1 is kept |
| After saving, the customer asks for that drink | The new item is found (the index refreshes within seconds) |
| Stranger texts "update the menu" | Treated as a customer: ownership comes from the handle, never the text |
