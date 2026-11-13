import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire, registerHooks } from 'node:module';
import { test } from 'node:test';

const bundle = new URL('../bundles/dsh-compose-app/', import.meta.url);
const prefix = process.env.DSH_TEST_PREFIX ?? process.env.DSH_PREFIX;
if (!prefix) throw new Error('DSH_TEST_PREFIX must point to the prepared engine');
const upstream = pathToFileURL(resolve(prefix, 'node_modules/@deepseek-ai/dsh-web-app') + '/');
const requireInstalled = createRequire(new URL('package.json', upstream));
// Resolve source imports against the existing offline installation; no copies or installs.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(bundle.href) && !specifier.startsWith('.') && !specifier.startsWith('node:')) {
      return nextResolve(specifier, { ...context, parentURL: new URL('lib/index.js', upstream).href });
    }
    return nextResolve(specifier, context);
  },
});
const app = await import(new URL('lib/index.js', bundle));
const startup = await import(new URL('lib/startup.js', bundle));
const { internals: cmdlineStreams } = await import(requireInstalled.resolve('@deepseek-ai/dsh-cmdline'));
const { Context } = await import(requireInstalled.resolve('@deepseek-ai/cordis'));
const yaml = requireInstalled('yaml');
const schema = { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] };
const read = (url) => readFileSync(url, 'utf8');

function context(t) {
  const state = { registrations: 0, authorizations: 0, renders: [], env: [] };
  const ctx = {
    root: { loader: { entries: () => [] } },
    webServer: {
      getOrigin: () => 'http://127.0.0.1:3080',
      registerFallback(fallback) { state.registrations++; state.resource = fallback.resource; return () => {}; },
      renderIndex(html, peer) { state.renders.push(peer); return html.replace('</head>', '<meta name="injected"></head>'); },
    },
    connection: {
      browserPeer: {},
      authenticatedUrl(url) { const result = new URL(url); result.searchParams.set('token', 'offline-token'); return result.href; },
      authorizeIndex(request, response) {
        state.authorizations++;
        if (new URL(request.url).searchParams.get('token') === 'offline-token') {
          response.writeHead(303, { location: './', 'set-cookie': 'dsh-auth-test=offline; HttpOnly' });
          response.end();
          return false;
        }
        if (request.headers.get('cookie') === 'dsh-auth-test=offline') return true;
        response.writeHead(401, { 'content-type': 'text/plain' });
        response.end('Unauthorized');
        return false;
      },
    },
    shellEnv: { register(value) { state.env.push(value); } },
    provide(key, value) { this[key] = value; },
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') t.after(dispose); return dispose; },
    inject(services, fn) { return fn(this); },
    get(key) { return this[key]; },
  };
  return { ctx, state };
}

test('fallback forwards authentication and renders only the root for the admitted peer', async t => {
  const { ctx, state } = context(t);
  assert.equal(app.name, 'compose-app');
  assert.deepEqual(app.inject, ['webServer', 'connection']);
  app.apply(ctx, app.Config({ printPairingCode: false }));
  assert.equal(state.registrations, 1);
  const request = (path, options) => new Request('http://127.0.0.1:3080' + path, options);
  const redirect = await state.resource(request('/?token=offline-token'));
  assert.equal(redirect.status, 303);
  assert.equal(redirect.headers.get('location'), './');
  assert.equal(redirect.headers.get('set-cookie'), 'dsh-auth-test=offline; HttpOnly');
  const denied = await state.resource(request('/'));
  assert.equal(denied.status, 401);
  assert.equal(await denied.text(), 'Unauthorized');
  const options = { headers: { cookie: 'dsh-auth-test=offline' } };
  const ok = await state.resource(request('/', options));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.match(await ok.text(), /name="injected"/);
  assert.equal(state.renders.at(-1), ctx.connection.browserPeer);
  const head = await state.resource(request('/', { ...options, method: 'HEAD' }));
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  const calls = state.authorizations;
  assert.equal((await state.resource(request('/x'))).status, 404);
  const peer = {};
  assert.equal((await state.resource(request('/'), peer)).status, 200);
  assert.equal(state.authorizations, calls);
  assert.equal(state.renders.at(-1), peer);
  assert.deepEqual(state.env[0].resolve(), { DSH_WEB_URL: ctx.webApp.getAdvertisedUrl() });
});

test('fallback can access authentication through a real Cordis plugin context', async t => {
  const root = new Context();
  const { ctx, state } = context(t);
  await root.plugin((provider) => {
    provider.provide('webServer', ctx.webServer);
    provider.provide('connection', ctx.connection);
  }).await();
  try {
    await root.plugin(app, { printPairingCode: false, surfaceContext: false }).await();
    const response = await state.resource(new Request('http://127.0.0.1:3080/?token=offline-token'));
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('set-cookie'), 'dsh-auth-test=offline; HttpOnly');
  } finally {
    await root.fiber.dispose();
  }
});

test('pairing code announcement waits for loader and audit, once per root', async t => {
  const { ctx, state } = context(t);
  const home = mkdtempSync(join(tmpdir(), 'compose-announcement-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });
  let settle;
  let audits = 0;
  ctx.loader = { await: () => new Promise((resolve) => { settle = resolve; }) };
  ctx.root.loader.entries = () => { audits++; return []; };
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(line);
  try {
    const config = app.Config({ publicUrl: 'https://app.example/prefix' });
    app.apply(ctx, config);
    assert.deepEqual(lines, []);
    settle();
    await new Promise(setImmediate);
    assert.equal(audits, 1);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^Pairing code \(one use, expires in 5 minutes\): \d{4}-\d{4}$/);
    assert.deepEqual(state.env[0].resolve(), { DSH_WEB_URL: 'https://app.example/prefix/' });
    // A later plugin lifetime in the same root must not print a second invitation.
    app.apply(ctx, config);
    settle();
    await new Promise(setImmediate);
    assert.equal(lines.length, 1);
  } finally { console.log = original; }
});

test('startup preserves flags and rejects wildcard binds', () => {
  assert.equal(startup.name, 'compose-startup');
  function parse(args) {
    const result = { exits: [], output: '' };
    const old = cmdlineStreams.stderr;
    cmdlineStreams.stderr = { write(text) { result.output += text; } };
    try {
      startup.apply({
        get(key) { return key === 'cmdlineArgs' ? { get: () => args } : (code) => result.exits.push(code); },
        provide(key, value) { assert.equal(key, 'webStartup'); result.value = value; },
      });
    } finally { cmdlineStreams.stderr = old; }
    return result;
  }
  const ok = parse(['--host', '127.0.0.1', '--port', '0', '--no-open']);
  assert.deepEqual(ok.exits, []);
  assert.deepEqual(ok.value, { openBrowser: false, host: '127.0.0.1', port: 0, trustedHosts: [] });
  const tls = parse(['--public-url', 'https://app.example/', '--trusted-host', 'app.example', '--tls-cert', 'cert.pem', '--tls-key', 'key.pem']);
  assert.deepEqual(tls.value.tls, { certFile: 'cert.pem', keyFile: 'key.pem' });
  assert.equal(tls.value.publicUrl, 'https://app.example/');
  assert.deepEqual(tls.value.trustedHosts, ['app.example']);
  const bad = parse(['--host', '0.0.0.0']);
  assert.deepEqual(bad.exits, [1]);
  assert.equal(bad.value, undefined);
  assert.match(bad.output, /wildcard/);
});

test('compose profile declares its transport, model selection and research services', () => {
  const rows = yaml.parse(read(new URL('cordis.patch.yml', bundle)), schema).flatMap(row => row.insert ?? [row]);
  assert.deepEqual(rows.find(row => row.id === 'typert-gateway'), { id: 'typert-gateway', config: { websocketHeartbeatIntervalMs: 20000 } });
  assert.deepEqual(rows.find(row => row.id === 'agent-default-model'), {
    id: 'agent-default-model', name: 'dsh-compose-app/default-model', config: { provider: 'deepseek-official', model: 'deepseek-flash' },
  });
  assert.deepEqual(rows.find(row => row.id === 'compose-protocol'), { id: 'compose-protocol', name: 'dsh-compose-app/protocol' });
  assert.deepEqual(rows.find(row => row.id === 'compose-research'), { id: 'compose-research', name: 'dsh-compose-app/research' });
});
