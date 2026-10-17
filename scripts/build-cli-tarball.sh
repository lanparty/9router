#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DATA_DIR="${BUILD_DATA_DIR:-$ROOT/cli/.build-home/.9router}"

cd "$ROOT"
export DATA_DIR="$BUILD_DATA_DIR"

npm install
npm --prefix cli install
npm run cli:pack

TARBALL="$(ls -1t "$ROOT"/9router-*.tgz 2>/dev/null | head -1)"
if [[ -z "$TARBALL" ]]; then
  echo "No CLI tarball was produced" >&2
  exit 1
fi

printf 'CLI tarball: %s\n' "$TARBALL"
printf 'Install globally with: npm i -g %q\n' "$TARBALL"
