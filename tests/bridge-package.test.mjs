// package.json's "files" decides what the package ships. A file left out still works from a
// checkout and only fails once installed, so walk the imports against the pack list.
//   node --test tests/bridge-package.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { posix, join } from "node:path";

const ROOT = new URL("../bridge/dsh-compose-bridge/", import.meta.url);

function packedFiles(t) {
  const dir = mkdtempSync(join(tmpdir(), "compose-pack-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const result = execFileSync("npm", ["pack", "--json", "--pack-destination", dir, "--ignore-scripts"], { cwd: ROOT, encoding: "utf8" });
  const archive = join(dir, JSON.parse(result)[0].filename);
  const paths = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" });
  return new Set(paths.trim().split("\n").map(path => path.replace(/^package\//, "")));
}

function localImports(file) {
  const text = readFileSync(new URL(file, ROOT), "utf8");
  return [...text.matchAll(/^\s*(?:import|export)\b[^'"]*?from\s*['"](\.[^'"]+)['"]/gm)].map((match) =>
    posix.join(posix.dirname(file), match[1]),
  );
}

test("the package holds everything its entry points import", t => {
  const { exports: entries } = JSON.parse(readFileSync(new URL("package.json", ROOT), "utf8"));
  const queue = Object.values(entries).filter((target) => target.endsWith(".js")).map(posix.normalize);
  const packed = packedFiles(t);
  const seen = new Set();
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    assert.ok(packed.has(file), `${file} is imported but missing from "files"`);
    queue.push(...localImports(file));
  }
  // The walk must have followed the graph, or it would pass with nothing to check.
  assert.ok(seen.has("lib/session-deletion.js") && seen.has("lib/native/core.js"));
});
