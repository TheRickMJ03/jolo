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
