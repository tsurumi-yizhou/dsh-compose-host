// Build an independent test prefix without re-resolving any runtime entry.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
const { values } = parseArgs({ options: { out: { type: 'string' } } });
assert.ok(isAbsolute(values.out ?? ''), '--out must be a new absolute directory');
const base = new URL('../../../../locks/dsh-0.2.2-rc.3/', import.meta.url);
const original = await readFile(new URL('package-lock.json', base));
const manifest = JSON.parse(await readFile(new URL('package.json', base)));
const lock = JSON.parse(original);
assert.equal(manifest.dependencies['@deepseek-ai/dsh'], '0.2.2-rc.3');
const additions = [
  ['@deepseek-ai/dsh-llm-mock-server', '0.2.2-rc.3', 'https://registry.npmjs.org/@deepseek-ai/dsh-llm-mock-server/-/dsh-llm-mock-server-0.2.2-rc.3.tgz', 'sha512-1CMG03f2hxWOkm9pOP18Ax0aIjVYLUsgnNJhcduAm88LV612ng+ZFS29uiE/coE40WApVPGKOJeVnDFdSoEVVA=='],
  ['image-size', '2.1.0', 'https://registry.npmjs.org/image-size/-/image-size-2.1.0.tgz', 'sha512-6Dbisa46RsgeAh3TMSFL2i8+uIFG+/LRmz6Q2oscSJJvXo1sOw3EgNO4M8jPl1P+gR1atJLDPrpclX4IHz63sA=='],
];
for (const [name, version, resolved, integrity] of additions) {
  const key = 'node_modules/' + name;
  assert.equal(lock.packages[key], undefined, 'test addition must not replace a runtime lock entry');
  manifest.dependencies[name] = version;
  lock.packages[''].dependencies[name] = version;
  lock.packages[key] = { version, resolved, integrity, license: 'MIT' };
}
await mkdir(values.out, { mode: 0o700 });
for (const [file, value] of [['package.json', manifest], ['package-lock.json', lock], ['test-inputs.json', {
  runtimeLockSha256: createHash('sha256').update(original).digest('hex'),
  preservedRuntimeEntries: Object.keys(JSON.parse(original).packages).length - 1,
  additions: additions.map(([name, version]) => ({ name, version })),
}]]) await writeFile(join(values.out, file), JSON.stringify(value, null, 2) + '\n');
console.log(values.out);
