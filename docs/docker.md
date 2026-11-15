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

## Using Firestore instead of the JSON file

Plain `docker compose up` keeps the store in `data/store.json`. Two override files switch the brain to Firestore (`JOLO_STORE_BACKEND=firestore`). The search index is rebuilt automatically when you switch.

**Local emulator** (no account, no key; do this first):

```bash
docker compose -f docker-compose.yml -f docker-compose.emulator.yml up -d --build
```

This adds a `firestore` container running the emulator with the app's own rules from `jolo-app/`. Every start adds any missing demo and real cafés. Data survives restarts in the `firestore-data` volume. You can browse it at http://localhost:4000, and the emulator is on `localhost:8080` for `jolo-app` and host scripts (`FIRESTORE_EMULATOR_HOST=localhost:8080`). Don't run `npm run emulators` at the same time, because both use port 8080.

**Real Firebase project** (the one the app uses; see [`firebase-intro.md`](firebase-intro.md)):

1. Put the service-account key at `secrets/serviceAccount.json` (git-ignored), or set `FIREBASE_KEY_FILE` in `.env`.
2. Set `FIREBASE_PROJECT_ID` in `.env`.
3. Start it, then load the real cafés once (nothing is written automatically):

```bash
docker compose -f docker-compose.yml -f docker-compose.firebase.yml up -d --build
docker compose -f docker-compose.yml -f docker-compose.firebase.yml exec jolo python scripts/load_real_cafes.py --really-write-to-firestore
docker compose -f docker-compose.yml -f docker-compose.firebase.yml exec jolo python scripts/build_index.py
```

If the key file is missing, Docker creates an empty folder in its place and the brain cannot log in. Delete that folder and put the key there.
