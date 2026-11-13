import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const prefix = process.env.DSH_TEST_PREFIX ?? process.env.DSH_PREFIX;

// Exercise the public transport with real HTTP/WS. Business dispatch is an
// in-memory engine so this test needs neither a model account nor a phone.
test('device pairing owns RPC, event streams, cancellation and revocation', {
  skip: !prefix && 'set DSH_TEST_PREFIX to a prepared DSH install', timeout: 10000,
}, async t => {
  const root = mkdtempSync(join(tmpdir(), 'compose-transport-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = root;
  const disposers = [], routes = [], upgrades = [];
  let server;
  t.after(async () => {
    for (const dispose of disposers.reverse()) await dispose();
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  });
  cpSync(new URL('../bundles/dsh-compose-app/lib/protocol/', import.meta.url), join(root, 'protocol'), { recursive: true });
  symlinkSync(resolve(prefix, 'node_modules'), join(root, 'node_modules'), 'dir');
  const { apply } = await import(pathToFileURL(join(root, 'protocol/index.mjs')));
  const { WebSocket } = createRequire(pathToFileURL(join(root, 'entry.cjs')))('ws');
  class WebServer {
    static dshComposeOpenRoutes = new Set();
    getOrigin() { return `http://127.0.0.1:${server.address().port}`; }
    register(route) { routes.push(route); return () => {}; }
    registerUpgrade(route) { upgrades.push(route); return () => {}; }
  }
  let executions = 0, release, started;
  const entered = new Promise(resolve => { started = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  let peer;
  const ctx = {
    inject(services, callback) { if (services.every(name => this[name])) return callback(this); },
    webServer: new WebServer(),
    get(name) { return this[name]; },
    provide(name, value) { this[name] = value; },
    effect(run) { disposers.push(run()); },
    connection: {
      isTrusted: req => !req.headers.origin || req.headers.origin === ctx.webServer.getOrigin(),
      authenticatedUrl: origin => `${origin}/?token=test-local-launch`,
      createPeer() {
        const control = new AbortController();
        peer = { signal: control.signal, dispose() { control.abort(); } };
        return peer;
      },
      createSharedFetchHandler: () => ({ fetch: () => new Response(null, { status: 404 }) }),
    },
    typertGateway: {
      async dispatchRpc(method, payload, signal, owner) {
        assert.equal(owner, peer);
        executions++;
        if (method === 'wait') { started(); await waiting; }
        if (method === 'cancel') {
          started();
          await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
          return { ok: false, error: { code: 'request/cancelled' } };
        }
        return { ok: true, value: payload.args };
      },
      wireStream: {
        async *open(method, payload, input, owner, signal) {
          assert.equal(owner, peer);
          assert.equal(method, 'terminal');
          for await (const value of input) {
            signal.throwIfAborted();
            yield value;
          }
        },
        failure: error => ({ code: error.code ?? 'internal' }),
      },
    },
  };
  apply(ctx);
  server = createServer((req, res) => routes[0].handler(req, res));
  server.on('upgrade', (req, socket, head) => upgrades[0].handler(req, socket, head));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = ctx.webServer.getOrigin();
  let credential;
  const request = (path, body, extra = {}) => fetch(`${origin}/compose/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(credential ? { authorization: `Bearer ${credential}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...extra,
  });
  assert.equal((await request('devices')).status, 401);
  const paired = await (await request('pair', { code: 'test-local-launch', name: 'Android' })).json();
  credential = paired.credential;
  assert.equal(typeof credential, 'string');
  assert.equal((await request('devices', undefined, { headers: { authorization: `Bearer ${credential}`, origin: 'https://foreign.invalid' } })).status, 403);
  const envelope = { id: randomUUID(), sentAt: Date.now(), method: 'wait', args: { text: 'hello' } };
  const first = request('rpc', envelope);
  await entered;
  const duplicate = request('rpc', envelope);
  release();
  assert.deepEqual(await (await first).json(), { id: envelope.id, result: envelope.args });
  const second = await (await duplicate).json();
  // A duplicate arriving after completion deliberately reports an unknown result.
  assert.ok(second.result?.text === 'hello' || second.error?.code === 'request/outcome-unknown');
  assert.equal(executions, 1);
  const cancelEntered = new Promise(resolve => { started = resolve; });
  const cancelId = randomUUID();
  const cancelled = request('rpc', { id: cancelId, sentAt: Date.now(), method: 'cancel', args: {} });
  await cancelEntered;
  assert.deepEqual(await (await request('cancel', { id: cancelId })).json(), { cancelled: true });
  assert.equal((await (await cancelled).json()).error.code, 'request/cancelled');

  const socket = new WebSocket(origin.replace('http:', 'ws:') + '/compose/events', {
    headers: { authorization: `Bearer ${credential}` },
  });
  t.after(() => socket.terminate());
  await once(socket, 'open');
  const streamId = randomUUID();
  const event = once(socket, 'message');
  socket.send(JSON.stringify({ op: 'subscribe', id: streamId, method: 'terminal', args: {} }));
  socket.send(JSON.stringify({ op: 'input', id: streamId, data: { text: 'typed' } }));
  assert.deepEqual(JSON.parse((await event)[0]), { op: 'event', id: streamId, data: { text: 'typed' } });
  const closed = once(socket, 'close');
  const revoked = await request(`devices/${paired.deviceId}`, undefined, { method: 'DELETE' });
  assert.deepEqual(await revoked.json(), { revoked: paired.deviceId });
  await closed;
  assert.equal(peer.signal.aborted, true);
  assert.equal((await request('devices')).status, 401);
});
