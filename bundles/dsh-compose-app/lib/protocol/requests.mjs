import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProtocolError } from './devices.mjs';

const WINDOW = 10 * 60 * 1000;
const MAX_RECEIPTS = 4096;

// A damaged receipt must still prevent replay until every request admitted before
// its write is outside the request window. It must not disable unrelated devices.
function readClaim(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // PRoot's hard-link store may have disappeared. Keep the receipt's identity
    // until its request window expires, without preventing protocol startup.
    try { return { signature: null, expiresAt: Math.ceil(lstatSync(path).mtimeMs) + WINDOW + 60_000 }; }
    catch (missing) { if (missing.code === 'ENOENT') return null; throw missing; }
  }
  let claim;
  try { claim = JSON.parse(text); } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  if (claim && typeof claim.signature === 'string' && Number.isSafeInteger(claim.expiresAt)) return claim;
  return { signature: null, expiresAt: Math.ceil(lstatSync(path).mtimeMs) + WINDOW + 60_000 };
}

function publishClaim(path, record, directory) {
  let descriptor;
  try { descriptor = openSync(path, 'wx', 0o600); } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
  // Reserve the final name exclusively, then persist it before executing the
  // operation. A partial write is an unknown outcome, never permission to replay.
  // Hard-link publication would leave receipts dependent on PRoot's .l2s store.
  try {
    writeFileSync(descriptor, JSON.stringify(record));
    fsyncSync(descriptor);
  } finally { closeSync(descriptor); }
  const parent = openSync(directory, 'r');
  try { fsyncSync(parent); } finally { closeSync(parent); }
  return true;
}

/** Persist claims, never request arguments or results that might contain provider credentials. */
export class Requests {
  constructor(directory, now = Date.now) {
    this.directory = directory;
    this.now = now;
    this.live = new Map();
    this.nextPruneAt = 0;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.prune();
  }

  prune() {
    const now = this.now();
    if (now < this.nextPruneAt) return;
    this.nextPruneAt = now + 30000;
    for (const name of readdirSync(this.directory)) {
      if (name.endsWith('.tmp')) {
        const stage = join(this.directory, name);
        if (statSync(stage).mtimeMs + WINDOW + 60_000 <= now) unlinkSync(stage);
        continue;
      }
      if (!name.endsWith('.json')) continue;
      const path = join(this.directory, name);
      const claim = readClaim(path);
      if (claim && claim.expiresAt <= now && !this.live.get(name.slice(0, -5))?.result) unlinkSync(path);
    }
    for (const [key, value] of this.live) if (value.expiresAt <= now && !value.result) this.live.delete(key);
  }

  async run(device, envelope, operation) {
    const { id, sentAt, method, args } = envelope;
    if (typeof id !== 'string' || !/^[\w-]{16,80}$/.test(id) || !Number.isSafeInteger(sentAt) ||
      typeof method !== 'string' || method.length > 200 || !args || typeof args !== 'object' || Array.isArray(args))
      throw new ProtocolError('request/invalid');
    const now = this.now();
    if (sentAt > now + 60_000 || sentAt + WINDOW <= now) throw new ProtocolError('request/expired', 409);
    const key = `${device.id}-${id}`;
    const signature = createHash('sha256').update(JSON.stringify({ sentAt, method, args })).digest('hex');
    const remembered = this.live.get(key);
    if (remembered) {
      if (remembered.signature !== signature) throw new ProtocolError('request/id-reused', 409);
      if (!remembered.result) throw new ProtocolError('request/outcome-unknown', 409);
      return remembered.result;
    }
    const path = join(this.directory, key + '.json');
    if (existsSync(path)) {
      const claim = readClaim(path);
      throw new ProtocolError(!claim || claim.signature === null || claim.signature === signature ? 'request/outcome-unknown' : 'request/id-reused', 409);
    }
    this.prune();
    if (readdirSync(this.directory).length >= MAX_RECEIPTS) throw new ProtocolError('request/busy', 503);
    const record = { signature, expiresAt: sentAt + WINDOW };
    if (!publishClaim(path, record, this.directory)) {
      const claim = readClaim(path);
      throw new ProtocolError(!claim || claim.signature === null || claim.signature === signature ? 'request/outcome-unknown' : 'request/id-reused', 409);
    }
    const control = new AbortController();
    device.requests.set(id, control);
    // Install the promise before invoking business code, so overlapping retries share it.
    record.result = Promise.resolve().then(() => operation(control.signal)).finally(() => device.requests.delete(id));
    this.live.set(key, record);
    try { return await record.result; }
    finally {
      // Keep the running promise for concurrent retries; completed calls retain only the claim.
      // Reconciliation reads the authoritative engine state after an uncertain response.
      record.result = undefined;
    }
  }

  cancel(device, id) {
    if (typeof id !== 'string') throw new ProtocolError('request/invalid');
    const request = device.requests.get(id);
    if (!request) throw new ProtocolError('request/not-running', 404);
    request.abort();
  }
}
