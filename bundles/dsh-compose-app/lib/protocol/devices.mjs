import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export class ProtocolError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}

const digest = value => createHash('sha256').update(value).digest('hex');
const DEVICE_IDLE_MS = 24 * 60 * 60 * 1000;
const expiresAt = grant => (grant.lastSeenAt ?? grant.createdAt) + DEVICE_IDLE_MS;
const matches = (value, expected) => {
  const actual = Buffer.from(digest(value));
  const wanted = Buffer.from(expected ?? '');
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
};

function atomicJson(path, value) {
  const stage = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(stage, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    renameSync(stage, path);
  } finally {
    if (existsSync(stage)) unlinkSync(stage);
  }
}

/** Device grants own their peers and every request/socket made through those peers. */
export class Devices {
  constructor({ directory, createPeer, bootstrapCode, now = Date.now }) {
    this.directory = directory;
    this.createPeer = createPeer;
    this.bootstrapCode = bootstrapCode;
    this.now = now;
    this.live = new Map();
    this.temporary = new Map();
    this.localCredentials = new Map();
    this.pairRequests = [];
    this.closed = false;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.path = join(directory, 'devices.json');
    this.grants = existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) : [];
    if (!Array.isArray(this.grants)) throw new Error('Invalid compose device store');
  }

  /** Reserve before reading the body; all clients share one bounded request budget. */
  reservePairRequest() {
    const now = this.now();
    this.pairRequests = this.pairRequests.filter(time => time > now - 60_000);
    if (this.pairRequests.length >= 10) {
      const error = new ProtocolError('pairing/rate-limited', 429);
      error.retryAfter = Math.max(1, Math.ceil((this.pairRequests[0] + 60_000 - now) / 1000));
      throw error;
    }
    this.pairRequests.push(now);
  }

  pair({ code, name }, local) {
    if (this.closed) throw new ProtocolError('service/stopped', 503);
    if (typeof code !== 'string' || code.length > 512 || typeof name !== 'string' || !name.trim() || name.length > 100)
      throw new ProtocolError('pairing/invalid');
    const bootstrap = local && matches(code, digest(this.bootstrapCode()));
    if (bootstrap && this.localCredentials.has(name.trim())) {
      const credential = this.localCredentials.get(name.trim());
      const grant = this.temporary.get(credential.deviceId);
      if (grant && expiresAt(grant) > this.now()) {
        this.renew(grant.id);
        return credential;
      }
      this.temporary.delete(credential.deviceId);
      this.localCredentials.delete(name.trim());
    }
    if (!bootstrap) {
      const pending = join(this.directory, 'pairing.json');
      if (!existsSync(pending)) throw new ProtocolError('pairing/expired', 401);
      const invitation = JSON.parse(readFileSync(pending, 'utf8'));
      if (invitation.expiresAt <= this.now())
        throw new ProtocolError('pairing/expired', 401);
      if ((invitation.failures ?? 0) >= 5)
        throw new ProtocolError('pairing/locked', 401);
      if (!matches(code, invitation.digest)) {
        invitation.failures = (invitation.failures ?? 0) + 1;
        atomicJson(pending, invitation);
        if (invitation.failures >= 5) throw new ProtocolError('pairing/locked', 401);
        throw new ProtocolError('pairing/invalid', 401);
      }
      // No await between consuming the invitation and publishing the device grant.
      unlinkSync(pending);
    }
    const token = randomBytes(32).toString('base64url');
    const grant = { id: randomUUID(), name: name.trim(), digest: digest(token), createdAt: this.now() };
    if (bootstrap) this.temporary.set(grant.id, grant);
    else {
      const next = [...this.grants, grant];
      atomicJson(this.path, next);
      this.grants = next;
    }
    const credential = { deviceId: grant.id, credential: `${grant.id}.${token}`, role: 'owner' };
    if (bootstrap) this.localCredentials.set(name.trim(), credential);
    return credential;
  }

  admit(authorization) {
    if (this.closed) throw new ProtocolError('service/stopped', 503);
    const match = /^Bearer ([\w-]{36})\.([\w-]{43})$/.exec(authorization ?? '');
    if (!match) throw new ProtocolError('device/unauthorized', 401);
    const grant = this.grants.find(item => item.id === match[1]) ?? this.temporary.get(match[1]);
    if (!grant || !matches(match[2], grant.digest)) throw new ProtocolError('device/unauthorized', 401);
    this.renew(grant.id);
    let device = this.live.get(grant.id);
    if (!device) {
      device = { id: grant.id, peer: this.createPeer(), sockets: new Set(), responses: new Set(), requests: new Map() };
      this.live.set(grant.id, device);
    }
    return device;
  }

  /** Called only after credential verification or activity on an authenticated socket. */
  renew(id) {
    if (this.closed) throw new ProtocolError('service/stopped', 503);
    const grant = this.grants.find(item => item.id === id) ?? this.temporary.get(id);
    if (!grant) throw new ProtocolError('device/unauthorized', 401);
    const now = this.now();
    if (expiresAt(grant) <= now) throw new ProtocolError('device/expired', 401);
    if ((grant.lastSeenAt ?? grant.createdAt) >= now) return;
    const renewed = { ...grant, lastSeenAt: now };
    if (this.temporary.has(id)) this.temporary.set(id, renewed);
    else {
      const next = this.grants.map(item => item.id === id ? renewed : item);
      atomicJson(this.path, next);
      this.grants = next;
    }
  }

  list() {
    return this.grants.map(grant => ({ id: grant.id, name: grant.name, createdAt: grant.createdAt,
      expiresAt: expiresAt(grant), role: 'owner' }));
  }

  async revoke(id, currentResponse) {
    if (!this.grants.some(item => item.id === id) && !this.temporary.has(id))
      throw new ProtocolError('device/not-found', 404);
    const next = this.grants.filter(item => item.id !== id);
    atomicJson(this.path, next);
    this.grants = next;
    this.temporary.delete(id);
    for (const [name, credential] of this.localCredentials) {
      if (credential.deviceId === id) this.localCredentials.delete(name);
    }
    const device = this.live.get(id);
    this.live.delete(id);
    if (device) {
      for (const request of device.requests.values()) request.abort();
      for (const socket of device.sockets) socket.close(1008, 'device/revoked');
      for (const response of device.responses) if (response !== currentResponse) response.destroy();
      await device.peer.dispose();
    }
  }

  async close() {
    this.closed = true;
    const devices = [...this.live.values()];
    this.live.clear();
    this.temporary.clear();
    this.localCredentials.clear();
    for (const device of devices) {
      for (const request of device.requests.values()) request.abort();
      for (const socket of device.sockets) socket.close(1001, 'service/stopped');
      for (const response of device.responses) response.destroy();
    }
    await Promise.all(devices.map(device => device.peer.dispose()));
  }
}

export function formatInvitation(code) {
  return code.slice(0, 4) + '-' + code.slice(4);
}

/** Explicit deployment-side action; only the digest is written to the deployment state. */
export function createInvitation(directory, now = Date.now()) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const code = String(randomInt(100_000_000)).padStart(8, '0');
  atomicJson(join(directory, 'pairing.json'), { digest: digest(code), expiresAt: now + 300_000, failures: 0 });
  return code;
}

/** Keep an unexpired invitation (including its failed attempts) until its deadline. */
export function refreshInvitation(directory, now = Date.now()) {
  try {
    const invitation = JSON.parse(readFileSync(join(directory, 'pairing.json'), 'utf8'));
    if (invitation.expiresAt > now) return undefined;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return createInvitation(directory, now);
}
