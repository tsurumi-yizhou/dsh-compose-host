// Run against a prepared runtime: DSH_PREFIX=/absolute/prefix node this-file.mjs
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { resolve, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, writeFile, readFile, readdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

if (!process.env.DSH_PREFIX) throw new Error('DSH_PREFIX must point to a prepared runtime');
const prefix = resolve(process.env.DSH_PREFIX), require = createRequire(join(prefix, 'package.json'));
const root = await mkdtemp(join(tmpdir(), 'compose-profile-live-'));
const home = join(root, 'home'), profileDirectory = join(home, 'profiles/compose');
process.env.DSH_HOME = home;
process.env.DSH_COMPOSE_READY_FILE = join(root, 'ready.json');
process.env.DSH_TELEMETRY_DISABLED = '1';
const source = new URL('../', import.meta.url);
const hook = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.startsWith(source.href) && !specifier.startsWith('.') && !specifier.includes(':')) {
    return next(specifier, { ...context, parentURL: pathToFileURL(join(prefix, 'package.json')).href });
  }
  return next(specifier, context);
} });
let runtime;
const startupMessages = [];
const originalLog = console.log;
console.log = (...args) => {
  startupMessages.push(args.join(' '));
  if (!args.join(' ').startsWith('Pairing code')) originalLog(...args);
};
try {
  await mkdir(join(root, 'node_modules'), { recursive: true });
  for (const name of await readdir(join(prefix, 'node_modules'))) {
    if (name.startsWith('dsh-compose-')) continue;
    await symlink(join(prefix, 'node_modules', name), join(root, 'node_modules', name));
  }
  const packages = { 'dsh-compose-app': 'bundles/dsh-compose-app',
    'dsh-compose-bridge': 'bridge/dsh-compose-bridge' };
  const manifest = JSON.parse(await readFile(join(prefix, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8'));
  for (const [name, path] of Object.entries(packages)) {
    await symlink(fileURLToPath(new URL(path, source)), join(root, 'node_modules', name));
    manifest.dependencies[name] = '0.1.0';
  }
  const anchor = join(root, 'package.json');
  await writeFile(anchor, JSON.stringify(manifest));
  await mkdir(profileDirectory, { recursive: true });
  await mkdir(join(profileDirectory, '.compose'));
  await writeFile(join(profileDirectory, 'package.json'), JSON.stringify({ name: 'compose-test', private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', ...Object.keys(packages)] } } }));
  const boot = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')));
  const { runProfile } = await import(pathToFileURL(join(prefix, 'node_modules/@deepseek-ai/dsh/lib/profile-boot.js')));
  const profile = boot.loadProfileDirectory('dsh', profileDirectory, anchor);
  runtime = await runProfile({ environment: boot.loadLayeredEnv('dsh'), profile: 'compose', patchFiles: [],
    args: ['--host', '127.0.0.1', '--port', '0', '--no-open'], resolvedProfile: { profile, installAnchor: anchor } });
  await boot.auditStartupEntries(runtime.ctx, 'compose-test', line => assert.fail(line));
  const origin = `http://127.0.0.1:${runtime.ctx.webServer.port}`;
  await runtime.ctx.loader.await();
  const announcement = startupMessages.find(line => /^Pairing code .*: \d{4}-\d{4}$/.test(line));
  assert.ok(announcement, 'startup prints an eight-digit pairing code');
  const ready = JSON.parse(await readFile(process.env.DSH_COMPOSE_READY_FILE, 'utf8'));
  assert.ok(typeof ready.token === 'string' && ready.token.length > 0);
  assert.equal(startupMessages.some(line => line.includes(ready.token)), false);
  assert.equal(startupMessages.some(line => /dsh compose: https?:/.test(line)), false);
  const code = announcement.match(/(\d{4}-\d{4})$/)[1].replace("-", "");
  const pairing = await fetch(origin + '/compose/pair', { method: 'POST',
    headers: { 'content-type': 'application/json', host: 'desktop.tail123.ts.net:3095' },
    body: JSON.stringify({ code, name: 'profile-test' }) });
  assert.equal(pairing.status, 200);
  const { credential } = await pairing.json();
  assert.ok(credential);
  console.log('PASS: complete profile starts and pairs over the compose protocol');
} finally {
  console.log = originalLog;
  await runtime?.ctx.fiber.dispose();
  hook.deregister();
  await rm(root, { recursive: true, force: true });
}
