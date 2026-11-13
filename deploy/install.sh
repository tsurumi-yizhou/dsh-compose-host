#!/bin/sh
# Installs the packaged compose profile into a deployment home.
# The repository owns the source; this directory contains the deployment package.
# Node executes the engine. npm installs its dependency tree.
set -eu

DSH_ROOT=${DSH_HOME:-$HOME/.dsh}
APP_DIR=${COMPOSE_APP_DIR:-$DSH_ROOT/dsh-app}
PKG_DIR=$APP_DIR/pkg
RUNTIME=$APP_DIR/runtime
PROFILE_DIR=$DSH_ROOT/profiles/compose
LOG=$APP_DIR/install.log

mkdir -p "$APP_DIR" "$PKG_DIR" "$RUNTIME" "$APP_DIR/bin" "$PROFILE_DIR"
exec 3>&1
exec >>"$LOG" 2>&1

step() { printf 'COMPOSE_INSTALL %s %s\n' "$1" "$2" >&3; }
fail() {
    printf 'COMPOSE_INSTALL error %s\n' "$1" >&3
    exit 2
}

# Engine execution and dependency installation are independent: the engine's
# module loader uses Node.js, while npm installs its packages.
JS=$(command -v node 2>/dev/null) || fail no-node
# The packaged engine declares Node >=24.9.0.
"$JS" -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 24 || (major === 24 && minor >= 9) ? 0 : 1)' || fail node-version-required
NPM=$(command -v npm 2>/dev/null) || fail package-manager-missing
step runtime-executable "$JS"
step package-manager npm
VERSION=$("$JS" -p 'require(process.argv[1]).dsh' "$PKG_DIR/version.json") || fail runtime-install-failed

# Persist the Node.js executable for launch and read-only state queries. Quote
# paths here, including homes containing spaces or shell metacharacters.
write_launchers() {
    "$JS" - "$APP_DIR" "$RUNTIME" <<'JS' || fail profile-install-failed
const { writeFileSync } = require("node:fs");
const [app, runtime] = process.argv.slice(2);
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
writeFileSync(`${app}/bin/js`, `#!/bin/sh\nexec ${quote(process.execPath)} "$@"\n`, { mode: 0o755 });
writeFileSync(`${app}/bin/dsh`, `#!/bin/sh\nexec ${quote(`${app}/bin/js`)} ${quote(`${runtime}/node_modules/@deepseek-ai/dsh/lib/bin.js`)} "$@"\n`, { mode: 0o755 });
JS
}

installed_version() {
    "$JS" -p 'require(process.argv[1]).version' "$RUNTIME/node_modules/@deepseek-ai/dsh/package.json" 2>/dev/null ||
        printf ''
}

step runtime "installing $VERSION"
LIVE_RUNTIME=$RUNTIME
RUNTIME=$(mktemp -d "$APP_DIR/runtime-stage.XXXXXX") || fail runtime-install-failed
cleanup_stage() {
    [ "$RUNTIME" = "$LIVE_RUNTIME" ] || rm -rf "$RUNTIME"
}
trap cleanup_stage EXIT HUP INT TERM
cp "$PKG_DIR/locks/package.json" "$RUNTIME/package.json"
cp "$PKG_DIR/locks/package-lock.json" "$RUNTIME/package-lock.json"
# Keep the pinned dependency graph while using the deployment registry.
"$JS" - "$RUNTIME/package-lock.json" <<'NODE' || fail runtime-install-failed
const { readFileSync, writeFileSync } = require("node:fs");
const path = process.argv[2];
const lock = JSON.parse(readFileSync(path, "utf8"));
for (const entry of Object.values(lock.packages ?? {})) {
    if (entry && typeof entry === "object") delete entry.resolved;
}
writeFileSync(path, `${JSON.stringify(lock)}\n`);
NODE
(cd "$RUNTIME" && "$NPM" ci --ignore-scripts --no-audit --no-fund --cache "$APP_DIR/package-cache") || fail runtime-install-failed
[ "$(installed_version)" = "$VERSION" ] || fail runtime-install-failed
step runtime "installed $VERSION"

step source deploying
cp -a "$PKG_DIR/overrides/." "$RUNTIME/" || fail runtime-build-failed
step source deployed

step profile linking
# The bundles run from the pinned runtime's node_modules so their imports resolve
# against the engine dependency tree; the standard profile only
# needs links, not a second dependency install. An existing compose profile is
# merged, never replaced: local bundles and settings stay where they are.
for bundle in dsh-compose-app dsh-compose-bridge; do
    rm -rf "$RUNTIME/node_modules/$bundle"
    cp -a "$PKG_DIR/bundles/$bundle" "$RUNTIME/node_modules/$bundle" ||
        fail profile-install-failed
done
# Publish the fully installed tree only after dependency installation and source compilation succeed.
REPLACED_RUNTIME="$APP_DIR/runtime-replaced"
[ ! -e "$REPLACED_RUNTIME" ] || fail runtime-install-failed
mv "$LIVE_RUNTIME" "$REPLACED_RUNTIME" || fail runtime-install-failed
if ! mv "$RUNTIME" "$LIVE_RUNTIME"; then
    mv "$REPLACED_RUNTIME" "$LIVE_RUNTIME"
    fail runtime-install-failed
fi
RUNTIME=$LIVE_RUNTIME
rm -rf "$REPLACED_RUNTIME"
"$JS" - "$PROFILE_DIR" "$RUNTIME" <<'NODE' || fail profile-install-failed
const { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } = require("node:fs");
const [profile, runtime] = process.argv.slice(2);
const bundles = ["dsh-compose-app", "dsh-compose-bridge"];
let manifest = { name: "dsh-profile-compose", private: true };
try {
    manifest = { ...JSON.parse(readFileSync(`${profile}/package.json`, "utf8")), ...manifest };
} catch {}
const existing = (manifest.dsh?.profile?.bundles ?? []).filter(name => name !== "dsh-compose-magpie");
rmSync(`${profile}/node_modules/dsh-compose-magpie`, { recursive: true, force: true });
// `@deepseek-ai/dsh-base` is the platform shell every profile composes over; keep
// it first even when the profile is created from scratch here.
manifest.dsh = {
    ...(manifest.dsh ?? {}),
    profile: {
        ...(manifest.dsh?.profile ?? {}),
        bundles: [...new Set(["@deepseek-ai/dsh-base", ...existing, ...bundles])],
    },
};
writeFileSync(`${profile}/package.json`, `${JSON.stringify(manifest, null, 2)}\n`);
mkdirSync(`${profile}/node_modules`, { recursive: true });
for (const bundle of bundles) {
    const link = `${profile}/node_modules/${bundle}`;
    rmSync(link, { recursive: true, force: true });
    symlinkSync(`${runtime}/node_modules/${bundle}`, link);
}
NODE
write_launchers
step profile linked

step skills installing
"$JS" "$PKG_DIR/install-skills.mjs" "$PKG_DIR/skills" "$DSH_ROOT" || fail skill-install-failed
step skills installed

step ready "$VERSION"
exit 0
