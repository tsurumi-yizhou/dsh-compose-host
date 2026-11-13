import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, unlinkSync, createReadStream, constants } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { ProtocolError } from './devices.mjs';

const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'unknown']);
const ID = /^[\w-]{36}$/;

/** Device-bound artifacts; deployment semantics belong to the receiving client. */
export class Deployments {
  constructor(directory, devices, now = Date.now) {
    this.directory = directory;
    this.devices = devices;
    this.now = now;
    this.clients = new Map();
    this.jobs = new Map();
    this.preparing = new Set();
    this.origins = new Map();
    this.waiting = new Set();
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try { this.origins = new Map(JSON.parse(readFileSync(join(directory, 'origins'), 'utf8'))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const file of readdirSync(directory).filter(name => name.endsWith('.json'))) {
      const job = JSON.parse(readFileSync(join(directory, file), 'utf8'));
      if (ID.test(job.id)) this.jobs.set(job.id, job);
    }
  }
  cleanup() {
    const now = this.now();
    for (const job of this.jobs.values()) {
      if (!TERMINAL.has(job.status) && job.expiresAt <= now)
        this.save({ ...job, status: 'unknown', message: 'Deployment receipt timed out', completedAt: now });
      const current = this.jobs.get(job.id);
      if (TERMINAL.has(current.status)) {
        this.removeFile(`${job.id}.artifact`);
        if ((current.completedAt ?? current.createdAt) + 86_400_000 <= now && !this.waiting.has(job.id)) {
          this.removeFile(`${job.id}.json`);
          this.jobs.delete(job.id);
        }
      }
    }
    // Incomplete staging from a terminated host has no published job.
    if (this.preparing.size === 0) for (const file of readdirSync(this.directory)) {
      if (file.endsWith('.artifact') && !this.jobs.has(file.slice(0, -9))) this.removeFile(file);
      if (file.endsWith('.tmp')) this.removeFile(file);
    }
  }
  removeFile(name) {
    try { unlinkSync(join(this.directory, name)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  bindPrompt(device, { sessionId, requestId }) {
    if (typeof sessionId !== 'string' || typeof requestId !== 'string') return;
    const key = JSON.stringify([sessionId, requestId]);
    const previous = this.origins.get(key);
    if (previous && previous !== device.id) throw new ProtocolError('deploy/prompt-owner', 403);
    this.origins.set(key, device.id);
    const target = join(this.directory, 'origins');
    writeFileSync(`${target}.tmp`, JSON.stringify([...this.origins]), { mode: 0o600 });
    renameSync(`${target}.tmp`, target);
  }
  originatingDevice(agent) {
    const events = agent?.session.snapshotEvents() ?? [];
    const message = [...events].reverse().find(event => event.type === 'user/message');
    const source = message?.data.source;
    const deviceId = source?.kind === 'user' && this.origins.get(JSON.stringify([agent.session.id, source.rpcId]));
    if (!deviceId) throw new Error('Run deploy from a conversation on the paired client.');
    return deviceId;
  }
  async deploy(path, exec) {
    const deviceId = this.originatingDevice(exec.agent);
    const job = await this.enqueue({ path, deviceId }, exec.agent.session.id);
    this.waiting.add(job.id);
    try {
      const deadline = Date.now() + 15 * 60_000;
      while (!TERMINAL.has(this.jobs.get(job.id).status) && Date.now() < deadline) {
        await delay(1000, undefined, { signal: exec.signal });
      }
      return this.public(this.jobs.get(job.id));
    } finally { this.waiting.delete(job.id); }
  }

  save(job) {
    const path = join(this.directory, `${job.id}.json`), stage = `${path}.tmp`;
    writeFileSync(stage, JSON.stringify(job), { mode: 0o600 });
    renameSync(stage, path);
    this.jobs.set(job.id, job);
  }
  listDevices() {
    return this.devices.list().filter(device => device.expiresAt > this.now() &&
      (this.clients.get(device.id)?.seenAt ?? 0) > this.now() - 60_000).map(device => ({
        deviceId: device.id, name: this.clients.get(device.id).name, application: this.clients.get(device.id).application,
      }));
  }
  poll(device, input) {
    if (typeof input.application !== 'string' || typeof input.name !== 'string')
      throw new ProtocolError('deploy/client-invalid');
    this.cleanup();
    this.clients.set(device.id, { application: input.application.slice(0, 100), name: input.name.slice(0, 100), seenAt: this.now() });
    return { jobs: [...this.jobs.values()].filter(job => job.deviceId === device.id && !TERMINAL.has(job.status)).map(job => this.public(job)) };
  }
  public(job) {
    const { id, deviceId, sessionId, name, kind, encoding, size, status, createdAt, expiresAt, message } = job;
    return { id, deviceId, sessionId, name, kind, encoding, size, status, createdAt, expiresAt, message };
  }
  owned(id, device) {
    const job = ID.test(id) && this.jobs.get(id);
    if (!job || job.deviceId !== device.id) throw new ProtocolError('deploy/not-found', 404);
    return job;
  }
  async enqueue({ path, deviceId }, sessionId) {
    this.cleanup();
    if (!sessionId || !isAbsolute(path)) throw new Error('Use an absolute artifact path and an owning agent session.');
    if (!this.listDevices().some(device => device.deviceId === deviceId)) throw new Error('The originating client is offline or deployment is disabled.');
    const active = [...this.jobs.values()].find(job => job.deviceId === deviceId && !TERMINAL.has(job.status));
    if (active) {
      if (active.path === path && active.sessionId === sessionId) return this.public(active);
      throw new Error('The selected device already has a deployment pending.');
    }
    if (this.preparing.has(deviceId)) throw new Error('An artifact is already being prepared for this device.');
    this.preparing.add(deviceId);
    const id = randomUUID(), target = join(this.directory, `${id}.artifact`);
    let source;
    try {
      source = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await source.stat();
      if (!stat.isFile() && !stat.isDirectory()) throw new Error('Artifact must be a file or directory.');
      if (stat.isFile() && stat.size > MAX_ARTIFACT_BYTES) throw new Error('Artifact exceeds 512 MiB.');
      const kind = stat.isDirectory() ? 'directory' : 'file';
      const encoding = kind === 'directory' ? 'tar' : 'identity';
      const output = await open(target, 'wx', 0o600);
      let size = 0;
      const bounded = new Transform({ transform(chunk, _, done) {
        size += chunk.length;
        done(size > MAX_ARTIFACT_BYTES ? new Error('Artifact exceeds 512 MiB') : null, chunk);
      } });
      if (kind === 'directory') {
        const archive = spawn('tar', ['-C', path, '-cf', '-', '.'], { stdio: ['ignore', 'pipe', 'pipe'] });
        let errorText = '';
        archive.stderr.on('data', chunk => { errorText = (errorText + chunk).slice(-2000); });
        const finished = new Promise((resolve, reject) => {
          archive.once('error', reject);
          archive.once('close', code => code === 0 ? resolve() : reject(new Error(`Cannot archive directory: ${errorText}`)));
        });
        try { await Promise.all([finished, pipeline(archive.stdout, bounded, output.createWriteStream())]); }
        catch (error) { archive.kill(); await finished.catch(() => {}); throw error; }
      } else await pipeline(source.createReadStream(), bounded, output.createWriteStream());
      const job = { id, deviceId, sessionId, path, name: path.split('/').filter(Boolean).pop(), kind, encoding,
        size, status: 'queued', createdAt: this.now(), expiresAt: this.now() + 86_400_000 };
      this.save(job);
      return this.public(job);
    } catch (error) { await unlink(target).catch(() => {}); throw error; }
    finally { await source?.close().catch(() => {}); this.preparing.delete(deviceId); }
  }
  receipt(device, id, input) {
    const job = this.owned(id, device);
    if (!['downloading', 'deploying', ...TERMINAL].includes(input.status)) throw new ProtocolError('deploy/status-invalid');
    if (TERMINAL.has(job.status)) { this.removeFile(`${id}.artifact`); return this.public(job); }
    const next = { ...job, ...(TERMINAL.has(input.status) ? { completedAt: this.now() } : {}), status: input.status, message: String(input.message ?? '').slice(0, 500) };
    this.save(next);
    if (TERMINAL.has(next.status)) {
      try { unlinkSync(join(this.directory, `${id}.artifact`)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return this.public(next);
  }
  async download(device, id, res) {
    this.cleanup();
    const job = this.owned(id, device);
    if (TERMINAL.has(job.status)) throw new ProtocolError('deploy/completed', 410);
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': job.size, 'cache-control': 'no-store' });
    await pipeline(createReadStream(join(this.directory, `${id}.artifact`)), res);
  }
}

export async function registerDeploymentTools(ctx, deployments) {
  const { defineTool } = await import('@deepseek-ai/dsh-tools');
  const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] };
  ctx.tools.register(defineTool({ name: 'deploy', description: 'Deliver a build artifact to the paired client that sent the current conversation message. The client pulls the file or directory and deploys it using its own workflow. Waits up to 15 minutes for its receipt; pending is not success. Do not resubmit pending deployments. Transfer copies are temporary; source build outputs are preserved.',
    parameters: { path: { type: 'string', required: true, description: 'Absolute path of a build output file or directory on this host.' } }, output,
    execute: async ({ path }, exec) => JSON.stringify(await deployments.deploy(path, exec)) }));
}
