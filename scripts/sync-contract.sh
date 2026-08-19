#!/usr/bin/env bash
# packages/contract/index.ts is the single source of truth for every payload
# shape that crosses the network. It is type-only, so it is copied into each app
# rather than resolved through a path alias: no runtime resolver, no build step.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cp "$ROOT/packages/contract/index.ts" "$ROOT/apps/api/src/contract.ts"
cp "$ROOT/packages/contract/index.ts" "$ROOT/apps/web/src/contract.ts"
echo "contract synced"
