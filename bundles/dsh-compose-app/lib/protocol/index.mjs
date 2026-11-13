import { homedir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { WebSocketServer } from 'ws';
import { Devices, ProtocolError } from './devices.mjs';
import { Requests } from './requests.mjs';
import { serveStreams } from './streams.mjs';
import { createEditor } from './editor.mjs';
import { Deployments, registerDeploymentTools } from './deployments.mjs';

export const name = 'compose-protocol';
export const inject = ['webServer', 'connection', 'typertGateway'];
const LOOPBACK = new Set(['127.0.0.1', '::1', '[::1]', 'localhost', '::ffff:127.0.0.1']);
const tailnetAddress = address => {
  const value = (address ?? '').toLowerCase().replace(/^::ffff:/, '');
  const parts = value.split('.').map(Number);
  return value.startsWith('fd7a:115c:a1e0:') ||
    (parts.length === 4 && parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255) &&
      parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127);
};
const FILES = new Map([
  ['/compose/files/upload', '/api/session/uploadFileBinary'],
  ['/compose/files/read', '/api/workspaceFiles/readBytes'],
  ['/compose/files/pdf', '/api/officeToPdf/render'],
  ['/compose/sessions/export', '/api/session.export'],
]);

function send(res, status, value) {
  if (res.destroyed) return;
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}
async function body(req, limit = 32 * 1024 * 1024) {
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json')
    throw new ProtocolError('request/content-type', 415);
  const parts = [];
  let length = 0;
  for await (const part of req) {
    length += part.length;
    if (length > limit) throw new ProtocolError('request/too-large', 413);
    parts.push(part);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(parts).toString('utf8')); }
  catch { throw new ProtocolError('request/invalid'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProtocolError('request/invalid');
  return value;
}

export function apply(ctx) {
  const state = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'profiles/compose/.state/transport');
  const devices = new Devices({
    directory: state,
    createPeer: () => ctx.connection.createPeer({ principal: { kind: 'owner' }, interactions: 'answer' }),
    bootstrapCode: () => new URL(ctx.connection.authenticatedUrl(ctx.webServer.getOrigin())).searchParams.get('token'),
  });
  const editor = createEditor(ctx);
  const deployments = new Deployments(join(state, 'deployments'), devices);
  ctx.inject(['tools'], toolCtx => registerDeploymentTools(toolCtx, deployments));
  ctx.effect(() => {
    deployments.cleanup();
    const timer = setInterval(() => {
      try { deployments.cleanup(); }
      catch (error) { console.error('Deployment cleanup failed:', error.message); }
    }, 60_000);
    timer.unref();
    return () => clearInterval(timer);
  }, 'compose: deployment cleanup');
  const requests = new Requests(join(state, 'requests'));
  const sockets = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 32 * 1024 * 1024 });
  const pathOf = req => new URL(req.url, 'http://compose.invalid').pathname;
  const local = req => {
    let host;
    try { host = new URL(`http://${req.headers.host}`).hostname; } catch { return false; }
    return LOOPBACK.has(req.socket.remoteAddress) && LOOPBACK.has(host);
  };
  const service = {
    /** The webserver and extension routes share this device admission boundary. */
    reject(req) {
      // Native requests over the tailnet still require device credentials (or a pairing code).
      // Browser requests keep the existing origin/authority boundary; forwarded headers grant no trust.
      const nativePrivateTransport = !req.headers.origin && !req.headers['sec-fetch-site'] &&
        ((tailnetAddress(req.socket.remoteAddress) && tailnetAddress(req.socket.localAddress)) ||
          (LOOPBACK.has(req.socket.remoteAddress) && LOOPBACK.has(req.socket.localAddress)));
      if (!nativePrivateTransport && !ctx.connection.isTrusted(req)) return 403;
      const publicTls = ctx.get('webStartup')?.publicUrl?.startsWith('https://');
      if (!req.socket.encrypted && !local(req) && !nativePrivateTransport && !(LOOPBACK.has(req.socket.remoteAddress) && publicTls)) return 403;
      if (pathOf(req) === '/compose/pair' && req.method === 'POST') return undefined;
      try { devices.admit(req.headers.authorization); return undefined; }
      catch (error) { return error.status ?? 503; }
    },
    track(req, res) {
      const device = devices.admit(req.headers.authorization);
      device.responses.add(res);
      res.once('close', () => device.responses.delete(res));
      return device;
    },
    trackUpgrade(req, socket) {
      const device = devices.admit(req.headers.authorization);
      const resource = { close: () => socket.destroy() };
      device.sockets.add(resource);
      socket.once('close', () => device.sockets.delete(resource));
      return device;
    },
  };
  ctx.provide('composeProtocol', service);
  // These routes own device authentication instead of the browser's launch-cookie gate.
  const webServer = ctx.webServer[Symbol.for('cordis.original')] ?? ctx.webServer;
  const admissionRoutes = ['prefix /compose', 'prefix /compose/extensions', 'upgrade /compose/events', 'upgrade /compose/extensions/v1/stream'];
  ctx.effect(() => {
    for (const route of admissionRoutes) webServer.constructor.dshComposeOpenRoutes.add(route);
    return () => { for (const route of admissionRoutes) webServer.constructor.dshComposeOpenRoutes.delete(route); };
  }, 'compose: device admission routes');
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/compose', handler: async (req, res) => {
    let id;
    try {
      const rejection = service.reject(req);
      if (rejection) throw new ProtocolError(rejection === 401 ? 'device/unauthorized' : 'device/refused', rejection);
      const path = pathOf(req);
      if (path === '/compose/pair' && req.method === 'POST') {
        devices.reservePairRequest();
        send(res, 200, devices.pair(await body(req, 4096), local(req)));
        return;
      }
      const device = service.track(req, res);
      if (path === '/compose/deployments/poll' && req.method === 'POST') {
        send(res, 200, deployments.poll(device, await body(req, 4096)));
        return;
      }
      const deployment = /^\/compose\/deployments\/([\w-]{36})\/(artifact|receipt)$/.exec(path);
      if (deployment) {
        if (deployment[2] === 'artifact' && req.method === 'GET')
          await deployments.download(device, deployment[1], res);
        else if (deployment[2] === 'receipt' && req.method === 'POST')
          send(res, 200, deployments.receipt(device, deployment[1], await body(req, 4096)));
        else throw new ProtocolError('request/method', 405);
        return;
      }
      if (path === '/compose/rpc' && req.method === 'POST') {
        const envelope = await body(req);
        id = envelope.id;
        const result = await requests.run(device, envelope, async signal => {
          if (envelope.method === 'editor/request') {
            return { ok: true, value: await editor.request(envelope.args, signal, device.peer) };
          }
          if (envelope.method === 'session/prompt') deployments.bindPrompt(device, envelope.args);
          return ctx.typertGateway.dispatchRpc(envelope.method, { args: envelope.args }, signal, device.peer);
        });
        send(res, 200, result.ok ? { id, result: result.value ?? null } : { id, error: result.error });
      } else if (path === '/compose/cancel' && req.method === 'POST') {
        requests.cancel(device, (await body(req)).id);
        send(res, 200, { cancelled: true });
      } else if (path === '/compose/devices' && req.method === 'GET') {
        send(res, 200, { devices: devices.list(), current: device.id });
      } else if (/^\/compose\/devices\/[\w-]{36}$/.test(path) && req.method === 'DELETE') {
        const revoked = path.split('/').pop();
        await devices.revoke(revoked, res);
        send(res, 200, { revoked });
      } else if (FILES.has(path) || path === '/compose/editor/resource') {
        const resource = path === '/compose/editor/resource';
        let target = new URL(req.url, ctx.webServer.getOrigin());
        if (resource) {
          if (req.method !== 'GET' && req.method !== 'HEAD') throw new ProtocolError('request/method', 405);
          const requested = target.searchParams.get('path');
          if (!requested?.startsWith('/') || requested.startsWith('//') || /[\\\r\n]/.test(requested))
            throw new ProtocolError('editor/resource-path');
          target = new URL(requested, ctx.webServer.getOrigin());
          if ([...target.searchParams.keys()].some(key => key.toLowerCase() === 'token'))
            throw new ProtocolError('editor/resource-path');
        } else target.pathname = FILES.get(path);
        const control = new AbortController();
        res.once('close', () => { if (!res.writableFinished) control.abort(); });
        const request = new Request(target, {
          method: req.method,
          headers: Object.fromEntries(Object.entries(req.headers).filter(([key]) =>
            !['authorization', 'cookie', 'host', 'connection'].includes(key))),
          ...(req.method === 'GET' || req.method === 'HEAD' ? {} : { body: req, duplex: 'half' }),
          signal: AbortSignal.any([control.signal, device.peer.signal]),
        });
        if (path === '/compose/files/upload') {
          if (req.method !== 'POST') throw new ProtocolError('request/method', 405);
          const envelope = {
            id: req.headers['x-compose-request-id'],
            sentAt: Number(req.headers['x-compose-sent-at']),
            method: 'files/upload',
            args: { sessionId: target.searchParams.get('sessionId'), name: target.searchParams.get('name'), size: req.headers['content-length'] ?? null },
          };
          id = envelope.id;
          const uploaded = await requests.run(device, envelope, async signal => {
            const response = await ctx.connection.createSharedFetchHandler('/api').fetch(
              new Request(request, { signal: AbortSignal.any([request.signal, signal]) }), device.peer);
            const chunks = [];
            let length = 0;
            if (response.body) for await (const chunk of response.body) {
              length += chunk.length;
              if (length > 65536) throw new ProtocolError('files/invalid-receipt');
              chunks.push(chunk);
            }
            let receipt;
            try { receipt = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
            catch { throw new ProtocolError('files/invalid-receipt'); }
            if (!receipt || typeof receipt.ok !== 'boolean') throw new ProtocolError('files/invalid-receipt');
            return { status: response.status, receipt };
          });
          send(res, uploaded.status, { ...uploaded.receipt, id: envelope.id });
          return;
        }
        const result = resource && !target.pathname.startsWith('/api/')
          ? await ctx.webServer.readResource(request, device.peer)
          : await ctx.connection.createSharedFetchHandler('/api').fetch(request, device.peer);
        res.writeHead(result.status, { ...Object.fromEntries(result.headers), 'cache-control': 'no-store' });
        if (result.body) await pipeline(Readable.fromWeb(result.body), res);
        else res.end();
      } else throw new ProtocolError('route/not-found', 404);
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      if (error.retryAfter) res.setHeader('retry-after', String(error.retryAfter));
      send(res, error.status ?? 500, { ...(typeof id === 'string' ? { id } : {}), error: { code: error.code ?? 'internal' } });
    }
  } }), 'compose: application protocol');
  ctx.effect(() => ctx.webServer.registerUpgrade({ path: '/compose/events', handler: (req, socket, head) => {
    const status = service.reject(req);
    if (status) {
      socket.end(`HTTP/1.1 ${status} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    const device = devices.admit(req.headers.authorization);
    sockets.handleUpgrade(req, socket, head, websocket => serveStreams(websocket, device, {
      renew: () => devices.renew(device.id),
      open(method, payload, input, peer, signal) {
        return method === 'editor/events' ? editor.events(payload.args, signal, peer)
          : ctx.typertGateway.wireStream.open(method, payload, input, peer, signal);
      },
      failure: error => error instanceof ProtocolError ? { code: error.code } : ctx.typertGateway.wireStream.failure(error),
    }));
  } }), 'compose: event streams');
  ctx.effect(() => async () => {
    await devices.close();
    await new Promise(resolve => sockets.close(resolve));
  }, 'compose: device lifetime');
}
