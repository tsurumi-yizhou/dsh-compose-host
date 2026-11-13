import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const installer = fileURLToPath(new URL('./install-skills.mjs', import.meta.url));

test('packaged skills reach the engine catalog and repairs preserve user content', async t => {
  const root = mkdtempSync(join(tmpdir(), 'compose-skills-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pkg = join(root, 'package');
  const home = join(root, 'home');
  mkdirSync(pkg);
  const unpack = spawnSync('tar', ['-xzf', join(repository, 'dist/host.tgz'), '-C', pkg], { encoding: 'utf8' });
  assert.equal(unpack.status, 0, unpack.stderr);
  const install = () => {
    const result = spawnSync(process.execPath, [installer, join(pkg, 'skills'), home], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  install();

  const prefix = process.env.DSH_TEST_PREFIX ?? process.env.DSH_PREFIX;
  assert.ok(prefix, 'DSH_TEST_PREFIX must point to the prepared engine');
  const { FileSystemSkillProvider } = await import(pathToFileURL(resolve(prefix, 'node_modules/@deepseek-ai/dsh-skill-filesystem/lib/index.js')));
  const warnings = [];
  const provider = new FileSystemSkillProvider({ get: () => undefined, logger: { warn: text => warnings.push(text) } }, {
    invalidate() {}, signal: new AbortController().signal,
  }, { dshHome: home, agentsHome: join(root, 'agents'), watch: false });
  t.after(() => provider.dispose());
  const candidates = await provider.list({});
  assert.ok(Array.isArray(candidates), JSON.stringify(candidates));
  const names = ['dsh-compose-plugin'];
  for (const name of names) assert.ok(candidates.some(skill => skill.name === name), name);
  const guide = candidates.find(skill => skill.name === 'dsh-compose-plugin');
  const loaded = await provider.get(guide, {});
  assert.match(loaded.content, /dsh-compose-plugin/);
  assert.deepEqual(warnings, []);

  const guideFile = join(home, 'skills/dsh-compose-plugin/SKILL.md');
  unlinkSync(guideFile);
  install();
  assert.match(readFileSync(guideFile, 'utf8'), /name: dsh-compose-plugin/);
  writeFileSync(guideFile, 'user guide');
  install();
  assert.equal(readFileSync(guideFile, 'utf8'), 'user guide');

  // Local skill transactions already retain user-owned paths. Remote deployment
  // must also preserve a linked user directory outside its selected DSH home.
  const outside = join(root, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'keep'), 'user files');
  const uiDirectory = join(home, 'skills/dsh-compose-plugin');
  rmSync(uiDirectory, { recursive: true });
  symlinkSync(outside, uiDirectory);
  install();
  assert.equal(readFileSync(join(outside, 'keep'), 'utf8'), 'user files');
  assert.throws(() => readFileSync(join(outside, 'SKILL.md')), { code: 'ENOENT' });
});
