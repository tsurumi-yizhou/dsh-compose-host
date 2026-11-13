import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Devices, createInvitation, formatInvitation, refreshInvitation } from '../bundles/dsh-compose-app/lib/protocol/devices.mjs';
import { Requests } from '../bundles/dsh-compose-app/lib/protocol/requests.mjs';

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'compose-devices-'));
  const createPeer = () => {
    const control = new AbortController();
    return { signal: control.signal, dispose: async () => control.abort() };
  };
  const devices = new Devices({ directory, createPeer, bootstrapCode: () => 'local-bootstrap' });
  t.after(async () => { await devices.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, devices, createPeer };
}

test('guessing exhausts the invitation across restarts; only a new invitation restores pairing', async t => {
  const { directory, devices, createPeer } = setup(t);
  const code = createInvitation(directory);
  assert.match(code, /^\d{8}$/);
  assert.equal(formatInvitation(code).replace("-", ""), code);
  assert.match(formatInvitation(code), /^\d{4}-\d{4}$/);
  for (let i = 0; i < 4; i++) {
    assert.throws(() => devices.pair({ code: `guess-${i}`, name: 'Phone' }, false), { code: 'pairing/invalid' });
  }
  await devices.close();
  const restarted = new Devices({ directory, createPeer, bootstrapCode: () => 'local-bootstrap' });
  t.after(() => restarted.close());
  assert.throws(() => restarted.pair({ code: 'last-guess', name: 'Phone' }, false), { code: 'pairing/locked' });
  assert.throws(() => restarted.pair({ code, name: 'Phone' }, false), { code: 'pairing/locked' });
  assert.equal(restarted.list().length, 0);
  const grant = restarted.pair({ code: createInvitation(directory), name: 'Phone' }, false);
  assert.equal(restarted.admit(`Bearer ${grant.credential}`).id, grant.deviceId);
});

test('pairing request budget is shared, stays bounded during floods, and recovers after one minute', t => {
  const { devices } = setup(t);
  let now = 100_000;
  devices.now = () => now;
  for (let i = 0; i < 10; i++) devices.reservePairRequest();
  for (let i = 0; i < 100; i++) {
    assert.throws(() => devices.reservePairRequest(), { code: 'pairing/rate-limited', status: 429, retryAfter: 60 });
  }
  now += 59_000;
  assert.throws(() => devices.reservePairRequest(), { retryAfter: 1 });
  now += 1000;
  devices.reservePairRequest();
});

test('device expiry slides on authenticated activity, persists across restart, and cannot be revived after expiry', async t => {
  const { directory, devices, createPeer } = setup(t);
  const hour = 60 * 60 * 1000;
  let now = Date.now();
  const start = now;
  devices.now = () => now;
  const first = devices.pair({ code: createInvitation(directory), name: 'Phone' }, false);
  const second = devices.pair({ code: createInvitation(directory), name: 'Tablet' }, false);
  now += 23 * hour;
  devices.admit(`Bearer ${first.credential}`);
  assert.equal(devices.list().find(item => item.id === first.deviceId).expiresAt, now + 24 * hour);
  assert.equal(devices.list().find(item => item.id === second.deviceId).expiresAt, start + 24 * hour);
  await devices.close();
  const restarted = new Devices({ directory, createPeer, bootstrapCode: () => 'local-bootstrap', now: () => now });
  t.after(() => restarted.close());
  now = start + 25 * hour;
  assert.throws(() => restarted.admit(`Bearer ${second.credential}`), { code: 'device/expired' });
  restarted.admit(`Bearer ${first.credential}`);
  now += 23 * hour;
  restarted.renew(first.deviceId); // authenticated connection heartbeat
  assert.equal(restarted.list().find(item => item.id === first.deviceId).expiresAt, now + 24 * hour);
  now += 24 * hour;
  assert.throws(() => restarted.admit(`Bearer ${first.credential}`), { code: 'device/expired', status: 401 });
  assert.throws(() => restarted.renew(first.deviceId), { code: 'device/expired' });
});

test('incorrect credentials never extend a device grant', t => {
  const { directory, devices } = setup(t);
  let now = Date.now();
  devices.now = () => now;
  const { deviceId } = devices.pair({ code: createInvitation(directory), name: 'Phone' }, false);
  const expiry = devices.list()[0].expiresAt;
  now += 60_000;
  assert.throws(() => devices.admit(`Bearer ${deviceId}.${'x'.repeat(43)}`), { code: 'device/unauthorized' });
  assert.equal(devices.list()[0].expiresAt, expiry);
});

test('service restarts and fresh pairing codes retain existing device credentials', async t => {
  const { directory, devices, createPeer } = setup(t);
  let now = Date.now();
  devices.now = () => now;
  const phone = devices.pair({ code: createInvitation(directory), name: 'Phone' }, false);
  const tablet = devices.pair({ code: createInvitation(directory), name: 'Tablet' }, false);
  devices.admit(`Bearer ${phone.credential}`);
  devices.admit(`Bearer ${tablet.credential}`);
  await devices.close();
  for (let restart = 0; restart < 2; restart++) {
    now += 12 * 60 * 60 * 1000;
    const service = new Devices({ directory, createPeer, bootstrapCode: () => `bootstrap-${restart}`, now: () => now });
    createInvitation(directory); // startup announces a new invitation
    assert.equal(service.admit(`Bearer ${phone.credential}`).id, phone.deviceId);
    assert.equal(service.admit(`Bearer ${tablet.credential}`).id, tablet.deviceId);
    assert.equal(service.list().length, 2);
    assert.ok(service.list().every(item => item.expiresAt === now + 24 * 60 * 60 * 1000));
    await service.close();
  }
});

test('pairing is single use and persisted revocation cancels requests and all device transports', async t => {
  const { directory, devices, createPeer } = setup(t);
  const code = createInvitation(directory);
  const grant = devices.pair({ code, name: 'Phone' }, false);
  assert.throws(() => devices.pair({ code, name: 'Second phone' }, false), { code: 'pairing/expired' });
  const stored = readFileSync(join(directory, 'devices.json'), 'utf8');
  assert.equal(stored.includes(grant.credential.split('.')[1]), false);
  const device = devices.admit(`Bearer ${grant.credential}`);
  let socketClosed = false, responseClosed = false;
  device.sockets.add({ close() { socketClosed = true; } });
  device.responses.add({ destroy() { responseClosed = true; } });
  const requests = new Requests(join(directory, 'requests'));
  const envelope = { id: randomUUID(), sentAt: Date.now(), method: 'files/upload', args: { name: 'file' } };
  let began;
  const started = new Promise(resolve => { began = resolve; });
  const pending = requests.run(device, envelope, signal => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    began();
  }));
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await started;
  await devices.revoke(device.id);
  await rejected;
  assert.equal(socketClosed && responseClosed && device.peer.signal.aborted, true);
  assert.throws(() => devices.admit(`Bearer ${grant.credential}`), { code: 'device/unauthorized' });
  const restarted = new Devices({ directory, createPeer, bootstrapCode: () => 'new-bootstrap' });
  t.after(() => restarted.close());
  assert.throws(() => restarted.admit(`Bearer ${grant.credential}`), { code: 'device/unauthorized' });
});

test('concurrent duplicate writes share execution and a restart retains the claim without request secrets', async t => {
  const { directory, devices } = setup(t);
  const grant = devices.pair({ code: createInvitation(directory), name: 'Phone' }, false);
  const device = devices.admit(`Bearer ${grant.credential}`);
  const folder = join(directory, 'requests');
  const requests = new Requests(folder);
  const envelope = { id: randomUUID(), sentAt: Date.now(), method: 'provider/save', args: { key: 'private-test-credential' } };
  let finish;
  const answer = new Promise(resolve => { finish = resolve; });
  let calls = 0;
  const operation = () => { calls++; return answer; };
  const first = requests.run(device, envelope, operation);
  const duplicate = requests.run(device, envelope, operation);
  await assert.rejects(requests.run(device, { ...envelope, args: {} }, operation), { code: 'request/id-reused' });
  finish({ ok: true, value: 'saved' });
  assert.deepEqual(await first, await duplicate);
  assert.equal(calls, 1);
  const restarted = new Requests(folder);
  await assert.rejects(restarted.run(device, envelope, operation), { code: 'request/outcome-unknown' });
  assert.equal(calls, 1);
  const receipt = readFileSync(join(folder, readdirSync(folder)[0]), 'utf8');
  assert.equal(receipt.includes('private-test-credential'), false);
  assert.equal(receipt.includes('saved'), false);
});


test('an interrupted claim blocks replay while fresh requests remain available after restart', async t => {
  const { directory, devices } = setup(t);
  const grant = devices.pair({ code: createInvitation(directory), name: 'Phone' }, false);
  const device = devices.admit(`Bearer ${grant.credential}`);
  const folder = join(directory, 'requests');
  mkdirSync(folder);
  const envelope = { id: randomUUID(), sentAt: Date.now(), method: 'session/write', args: {} };
  const claim = join(folder, `${device.id}-${envelope.id}.json`);
  writeFileSync(claim, '{"signature":');
  const restarted = new Requests(folder);
  let writes = 0;
  const operation = () => { writes++; return { ok: true, value: 'done' }; };
  await assert.rejects(restarted.run(device, envelope, operation), { code: 'request/outcome-unknown' });
  assert.deepEqual(await restarted.run(device, { ...envelope, id: randomUUID() }, operation), { ok: true, value: 'done' });
  assert.equal(writes, 1);
  assert.equal(readdirSync(folder).some(name => name.endsWith('.tmp')), false);
});

test('invitation renewal respects the expiry and preserves lockout until then', async t => {
  const { directory, devices } = setup(t);
  const now = Date.now();
  const code = createInvitation(directory, now);
  for (let i = 0; i < 5; i++) assert.throws(() => devices.pair({ code: 'wrong', name: 'Phone' }, false));
  assert.equal(refreshInvitation(directory, now + 299_999), undefined);
  assert.throws(() => devices.pair({ code, name: 'Phone' }, false), { code: 'pairing/locked' });
  const next = refreshInvitation(directory, now + 300_000);
  assert.match(next, /^\d{8}$/);
  assert.equal(refreshInvitation(directory, now + 300_001), undefined);
  assert.ok(devices.pair({ code: next, name: 'Phone' }, false).credential);
});


test('a broken PRoot receipt does not block startup or permit replay, and new claims are regular files', async t => {
  const { directory, devices } = setup(t);
  const grant = devices.pair({ code: createInvitation(directory), name: 'Phone' }, false);
  const device = devices.admit(`Bearer ${grant.credential}`);
  const folder = join(directory, 'requests');
  mkdirSync(folder);
  let now = Date.now();
  const envelope = { id: randomUUID(), sentAt: now, method: 'session/write', args: {} };
  const claim = join(folder, `${device.id}-${envelope.id}.json`);
  symlinkSync(join(directory, '.l2s', 'missing'), claim);
  const requests = new Requests(folder, () => now);
  let writes = 0;
  const operation = () => { writes++; return { ok: true }; };
  await assert.rejects(requests.run(device, envelope, operation), { code: 'request/outcome-unknown' });
  const fresh = { ...envelope, id: randomUUID() };
  assert.deepEqual(await requests.run(device, fresh, operation), { ok: true });
  assert.equal(lstatSync(join(folder, `${device.id}-${fresh.id}.json`)).isFile(), true);
  assert.equal(writes, 1);
  now += 12 * 60_000;
  requests.prune();
  assert.deepEqual(readdirSync(folder), []);
});
