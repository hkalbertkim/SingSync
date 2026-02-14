#!/usr/bin/env bash
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: ./scripts/extract-sync-markers.sh <videoId> [--force]"
  exit 1
fi

(cd server && npm exec tsx src/scripts/extractSyncMarkers.ts "$@")
