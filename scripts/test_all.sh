#!/usr/bin/env bash
# Stage 0 of docs/test-flow.md: every automated suite, from the repo root.
#   bash scripts/test_all.sh
# Needs no credentials, network or model server. Run each part's install
# first (pip install -r requirements.txt; npm ci in the two app folders).
set -u
cd "$(dirname "$0")/.."

failed=()
run() {
  local name="$1"
  shift
  echo
  echo "== $name"
  if "$@"; then echo "-- $name: passed"; else failed+=("$name"); echo "-- $name: FAILED"; fi
}
in_dir() {
  local dir="$1"
  shift
  (cd "$dir" && "$@")
}

PYTHON="${PYTHON:-python}"
command -v "$PYTHON" >/dev/null 2>&1 || PYTHON=python3

run "Menu reader" "$PYTHON" -m pytest -q
run "Bridge: types" in_dir spectrum-archive-app npm run --silent typecheck
run "Bridge: tests" in_dir spectrum-archive-app npm test --silent
run "Owner app: lint" in_dir jolo-app npm run --silent lint
run "Owner app: types" in_dir jolo-app npm run --silent typecheck
run "Owner app: tests" in_dir jolo-app npm test --silent

# The Firestore emulator needs Java 21 or newer.
java_major=$(java -version 2>&1 | sed -n 's/.*version "\([0-9]*\).*/\1/p' | head -1)
if [ "${java_major:-0}" -ge 21 ]; then
  run "Firestore rules" in_dir jolo-app npm run --silent test:rules
else
  echo
  echo "== Firestore rules: SKIPPED (needs Java 21+, found ${java_major:-none}). CI runs it."
fi

echo
if [ ${#failed[@]} -eq 0 ]; then
  echo "All suites passed."
else
  echo "Failed: ${failed[*]}"
  exit 1
fi
