#!/bin/sh
set -e
cd /firebase

# Keep the emulator's data between restarts: load the last export, export again on stop.
set -- --only firestore --project "${GOOGLE_CLOUD_PROJECT:-demo-jolo}" --export-on-exit /data
if [ -f /data/firebase-export-metadata.json ]; then
  set -- "$@" --import /data
fi

exec firebase emulators:start "$@"
