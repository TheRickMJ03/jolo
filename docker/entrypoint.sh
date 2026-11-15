#!/bin/sh
set -e
cd /app

seed_demo() {
  if [ -n "$JOLO_OWNERS" ]; then
    set --; for o in $(echo "$JOLO_OWNERS" | tr ',' ' '); do set -- "$@" --owner "$o"; done
    python scripts/seed_store.py "$@"
  else
    python scripts/seed_store.py
  fi
}

load_real() {
  # The real Princeton cafés (no menus yet: owners add them). Skipped if the file is absent.
  if [ -f data/cafes_osm.yaml ]; then
    python scripts/load_real_cafes.py "$@" || echo "Could not load the real cafés."
  fi
}

BACKEND="${JOLO_STORE_BACKEND:-memory}"
if [ "$BACKEND" = "memory" ]; then
  # First start (empty volume): fill the store.
  if [ ! -f data/store.json ]; then
    echo "First start: seeding the store..."
    seed_demo
    load_real
  fi
elif [ -n "$FIRESTORE_EMULATOR_HOST" ]; then
  # Both scripts only add cafés that are missing, so this is safe on every start.
  echo "Firestore emulator at $FIRESTORE_EMULATOR_HOST: adding any missing cafés..."
  seed_demo
  load_real
else
  # The real project the app uses: never write to it automatically (see docs/firebase-intro.md).
  echo "Real Firestore project: nothing is seeded. To add the real cafés once, run:"
  echo "  docker compose -f docker-compose.yml -f docker-compose.firebase.yml exec jolo python scripts/load_real_cafes.py --really-write-to-firestore"
fi

# The index is built from the store, so rebuild it when the store changes (memory <-> emulator <-> real).
STORE_ID="$BACKEND ${FIRESTORE_EMULATOR_HOST:-${GOOGLE_CLOUD_PROJECT:-}}"
if [ ! -d data/index ] || [ "$(cat data/.index_store 2>/dev/null)" != "$STORE_ID" ]; then
  echo "Building the search index (downloads ~1.2 GB of models the first time)..."
  if python scripts/build_index.py; then
    echo "$STORE_ID" > data/.index_store
  else
    echo "Index build failed; search will be limited."
  fi
fi

exec python -m uvicorn api.app:create_app --factory --host 0.0.0.0 --port 8080
