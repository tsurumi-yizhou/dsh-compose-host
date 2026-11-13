// The compose bundle's agentDefaultModel against the real rc.1 settings forms; no live Host.
// DSH_PREFIX=/path/to/dsh-prefix node --test tests/default-model.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

if (!process.env.DSH_PREFIX) throw Error('Set DSH_PREFIX to a DSH prefix');
const prefix = pathToFileURL(resolve(process.env.DSH_PREFIX) + '/');
const base = join(resolve(process.env.DSH_PREFIX), 'node_modules/@deepseek-ai');
const bundle = new URL('../bundles/dsh-compose-app/', import.meta.url);
// Resolve the bundle's package imports against the prefix, as the runtime does.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(bundle.href) && !specifier.startsWith('.') && !specifier.startsWith('node:'))
      return nextResolve(specifier, { ...context, parentURL: prefix.href });
    return nextResolve(specifier, context);
  },
});
const { DefaultModelService } = await import(new URL('lib/default-model.js', bundle));
const { SettingsForms } = await import(pathToFileURL(join(base, 'dsh-settings/lib/index.js')));
const yaml = createRequire(new URL('package.json', prefix))('yaml');
const schema = { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] };
const old = { provider: 'fixture', model: 'old', reasoningEffort: 'high' };
const next = { provider: 'fixture', model: 'next', reasoningEffort: 'max' };
const fixedReceipt = { status: 'skipped', code: 'settings/fixed-default' };

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(raw = old, { beforeEdit } = {}) {
  const writes = [];
  const entry = { id: 'entry', options: { id: 'agent-default-model', config: structuredClone(raw) } };
  entry.fiber = { uid: 1, state: 2, runtime: { Config: DefaultModelService.Config }, ctx: {} };
  const defaults = Object.create(DefaultModelService.prototype);
  const update = value => {
    entry.options.config = structuredClone(value);
    entry.fiber.config = DefaultModelService.Config(structuredClone(value));
    entry.fiber.effectiveConfig = entry.fiber.config;
    defaults.config = entry.fiber.config;
  };
  update(raw);
  const editor = {
    entries: () => [entry],
    configuration: () => [{ entry, inherited: { ...old }, override: entry.options.config }],
    async edit(target, change) {
      assert.equal(target, entry);
      await beforeEdit?.();
      const config = await change(structuredClone(entry.options.config), old);
      update(config);
      writes.push(structuredClone(config));
    },
  };
  defaults.ownerContext = { fiber: { entry } };
  defaults.ctx = { get: name => name === 'configEditor' ? editor : undefined };
  defaults.saves = Promise.resolve();
  const settings = Object.create(SettingsForms.prototype);
  Object.assign(settings, {
    ownerContext: { configEditor: editor, emit: () => {} },
    revisions: new Map(), presentations: new Map(),
  });
  return { defaults, settings, entry, writes, update, raw: () => entry.options.config };
}

test('bundle row restates the dsh-base defaults it replaces', () => {
  const rows = rows => rows.flatMap(row => row.insert ?? [row]);
  const find = path => rows(yaml.parse(readFileSync(path, 'utf8'), schema)).find(row => row.id === 'agent-default-model');
  const upstream = find(join(base, 'dsh-base/cordis.patch.yml'));
  const compose = find(new URL('cordis.patch.yml', bundle));
  assert.equal(compose.name, 'dsh-compose-app/default-model');
  assert.deepEqual(compose.config, upstream.config);
});

test('settings namespace exposes editable boolean mode, defaulting old profiles to remember', async () => {
  const f = fixture();
  const descriptor = f.settings.describe().find(row => row.ns === 'agent-default-model');
  assert.equal(descriptor.value.rememberLastSelection, true);
  const root = descriptor.schema.refs[descriptor.schema.uid];
  const mode = descriptor.schema.refs[root.dict.rememberLastSelection];
  assert.equal(mode.type, 'boolean');
  assert.equal(mode.meta.default, true);
  await f.settings.mutate('agent-default-model', [
    { op: 'set', path: ['rememberLastSelection'], value: false },
    { op: 'set', path: ['model'], value: 'fixed' },
    { op: 'set', path: ['reasoningEffort'], value: 'max' },
  ], descriptor.revision);
  assert.deepEqual(f.defaults.currentSelection(), { provider: 'fixture', model: 'fixed', reasoningEffort: 'max' });
  assert.equal(f.defaults.remembersLastSelection(), false);
  assert.equal(f.writes.length, 1, 'existing mutate remains one atomic configuration edit');
});

test('remember writes model and effort, preserves explicit mode and unrelated raw config', async () => {
  const f = fixture({ ...old, rememberLastSelection: true, retained: 'synthetic' });
  assert.deepEqual(await f.defaults.saveSelection(next), { status: 'saved' });
  assert.deepEqual(f.raw(), { ...next, rememberLastSelection: true, retained: 'synthetic' });
  assert.deepEqual(await f.defaults.saveSelection({ provider: 'fixture', model: 'plain' }), { status: 'saved' });
  assert(!Object.hasOwn(f.raw(), 'reasoningEffort'), 'omitted effort clears the previous effort');
});

test('fixed default skips persistence', async () => {
  const f = fixture({ ...old, rememberLastSelection: false });
  assert.deepEqual(await f.defaults.saveSelection(next), fixedReceipt);
  assert.deepEqual(f.raw(), { ...old, rememberLastSelection: false });
  assert.equal(f.writes.length, 0);
});

test('queued remember save rechecks fixed mode under the editor lock, even with stale live refs', async () => {
  const gate = deferred(), entered = deferred();
  const f = fixture(old, { beforeEdit: () => { entered.resolve(); return gate.promise; } });
  const pending = f.defaults.saveSelection(next);
  await entered.promise;
  // Model the explicit settings mutation winning the editor lock before this callback.
  f.entry.options.config = { ...old, model: 'fixed', rememberLastSelection: false };
  gate.resolve();
  assert.deepEqual(await pending, fixedReceipt);
  assert.equal(f.raw().model, 'fixed');
  assert.equal(f.writes.length, 0, 'skipped callback never writes an unchanged profile');
});

test('save submission queue also rechecks a mode change before entering the editor', async () => {
  const f = fixture();
  const queue = deferred();
  f.defaults.saves = queue.promise;
  const pending = f.defaults.saveSelection(next);
  f.update({ ...old, rememberLastSelection: false });
  queue.resolve();
  assert.deepEqual(await pending, fixedReceipt);
  assert.equal(f.writes.length, 0);
});

test('a failed automatic save does not block later saves or reverse submission order', async () => {
  let edits = 0;
  const f = fixture(old, { beforeEdit: () => { if (++edits === 1) throw Error('synthetic write failure'); } });
  const failed = f.defaults.saveSelection(next);
  const second = f.defaults.saveSelection({ ...next, model: 'second' });
  const third = f.defaults.saveSelection({ ...next, model: 'third' });
  await assert.rejects(failed);
  assert.deepEqual(await second, { status: 'saved' });
  assert.deepEqual(await third, { status: 'saved' });
  assert.deepEqual(f.writes.map(row => row.model), ['second', 'third']);
});
