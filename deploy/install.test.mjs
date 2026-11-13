import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('failed dependency installation preserves the installed runtime and profile', t => {
  const root = mkdtempSync(join(tmpdir(), 'compose-install-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = join(root, 'dsh-app');
  const runtime = join(app, 'runtime');
  const profile = join(root, 'profiles/compose');
  const pkg = join(app, 'pkg');
  const bin = join(root, 'bin');
  for (const dir of [runtime, profile, join(pkg, 'locks'), bin]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(runtime, 'installed.txt'), 'active runtime');
  writeFileSync(join(profile, 'cordis.patch.yml'), 'user settings');
  writeFileSync(join(pkg, 'version.json'), '{"dsh":"0.2.2-rc.3"}');
  writeFileSync(join(pkg, 'locks/package.json'), '{"private":true}');
  writeFileSync(join(pkg, 'locks/package-lock.json'), '{"lockfileVersion":3,"packages":{}}');
  writeFileSync(join(bin, 'npm'), '#!/bin/sh\n[ "$1" = --version ] && exit 0\nexit 73\n', { mode: 0o755 });
  const result = spawnSync('sh', [fileURLToPath(new URL('./install.sh', import.meta.url))], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`,
      DSH_HOME: root, COMPOSE_APP_DIR: app },
    encoding: 'utf8',
  });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stdout, /COMPOSE_INSTALL error runtime-install-failed/);
  assert.equal(readFileSync(join(runtime, 'installed.txt'), 'utf8'), 'active runtime');
  assert.equal(readFileSync(join(profile, 'cordis.patch.yml'), 'utf8'), 'user settings');
  assert.equal(readdirSync(app).some(name => name.startsWith('runtime-stage.')), false);
});
