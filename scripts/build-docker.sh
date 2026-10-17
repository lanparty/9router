#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$ROOT"
IMAGE="${IMAGE:-9router-patched}"
TAG="${TAG:-0.5.75-upstream-first}"

cd "$REPO"
docker build -t "$IMAGE:$TAG" -t "$IMAGE:latest" .
printf 'Built %s:%s and %s:latest\n' "$IMAGE" "$TAG" "$IMAGE"
