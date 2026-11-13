#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$HERE/.work"
PACKAGE="$WORK/package"
mkdir -p "$WORK/dependencies" "$HERE/dist"
cp "$HERE/locks/package.json" "$HERE/locks/package-lock.json" "$WORK/dependencies/"
npm ci --prefix "$WORK/dependencies" --ignore-scripts --no-audit --no-fund
npm ci --prefix "$HERE/engine" --ignore-scripts --no-audit --no-fund
rm -rf "$PACKAGE"
mkdir -p "$PACKAGE/overrides" "$PACKAGE/bundles" "$PACKAGE/locks"
node "$HERE/engine/build.mjs" "$WORK/dependencies" "$PACKAGE/overrides"
# Prepare the same engine used by the host tests.
cp -a "$PACKAGE/overrides/." "$WORK/dependencies/"
cp "$HERE/locks/package.json" "$HERE/locks/package-lock.json" "$PACKAGE/locks/"
cp -a "$HERE/bundles/." "$PACKAGE/bundles/"
cp -a "$HERE/bridge/dsh-compose-bridge" "$PACKAGE/bundles/"
cp "$HERE/deploy/install.sh" "$HERE/deploy/compose.mjs" "$HERE/deploy/install-skills.mjs" "$PACKAGE/"
node "$HERE/sdk/plugin-kit/scripts/sync-skill.mjs"
cp -a "$HERE/skills" "$PACKAGE/"
cp "$HERE/LICENSE.md" "$PACKAGE/"
node --input-type=module - "$HERE/locks/package.json" "$PACKAGE/version.json" <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
const manifest = JSON.parse(readFileSync(process.argv[2], 'utf8'));
writeFileSync(process.argv[3], JSON.stringify({ dsh: manifest.dependencies['@deepseek-ai/dsh'] }) + '\n');
JS
tar -czf "$HERE/dist/host.tgz" -C "$PACKAGE" .
printf 'Built %s\n' "$HERE/dist/host.tgz"
