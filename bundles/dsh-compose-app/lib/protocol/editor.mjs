import { ProtocolError } from './devices.mjs';

const LIMIT = 16 * 1024 * 1024;
const REQUEST_HEADERS = new Set(['content-type', 'accept', 'range', 'if-none-match', 'if-modified-since']);
const RESPONSE_HEADERS = new Set(['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']);

export function createEditor(ctx) {
  function request(args, signal, events = false) {
    const { path, method = 'GET', headers = {}, body } = args;
    if (typeof path !== 'string' || !path.startsWith('/api/') || /[\\\r\n]/.test(path))
      throw new ProtocolError('editor/request-path');
    const target = new URL(path, ctx.webServer.getOrigin());
    if (!target.pathname.startsWith('/api/') || [...target.searchParams.keys()].some(key => key.toLowerCase() === 'token'))
      throw new ProtocolError('editor/request-path');
    if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(method))
      throw new ProtocolError('request/method', 405);
    if (!headers || typeof headers !== 'object' || Array.isArray(headers)) throw new ProtocolError('request/invalid');
    const safe = Object.entries(headers).filter(([key, value]) => REQUEST_HEADERS.has(key.toLowerCase()) && typeof value === 'string');
    if (body != null && (typeof body !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body)))
      throw new ProtocolError('request/invalid');
    const payload = body == null ? undefined : Buffer.from(body, 'base64');
    if (payload?.length > LIMIT) throw new ProtocolError('request/too-large', 413);
    if ((method === 'GET' || method === 'HEAD') && payload) throw new ProtocolError('request/invalid');
    return new Request(target, { method: events ? 'GET' : method, headers: events ? { accept: 'text/event-stream' } : safe, body: events ? undefined : payload, signal });
  }
  const fetch = (req, peer) => ctx.connection.createSharedFetchHandler('/api').fetch(req, peer);
  async function* chunks(response, signal) {
    if (!response.body) return;
    const reader = response.body.getReader();
    const abort = () => { reader.cancel().catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      while (true) {
        const { value, done } = await reader.read();
        signal.throwIfAborted();
        if (done) return;
        yield value;
      }
    } finally {
      signal.removeEventListener('abort', abort);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  return {
    async request(args, signal, peer) {
      const response = await fetch(request(args, signal), peer);
      let length = 0;
      const parts = [];
      for await (const part of chunks(response, signal)) {
        length += part.length;
        if (length > LIMIT) throw new ProtocolError('editor/response-too-large');
        parts.push(part);
      }
      return {
        status: response.status,
        headers: Object.fromEntries([...response.headers].filter(([key]) => RESPONSE_HEADERS.has(key))),
        body: Buffer.concat(parts).toString('base64'),
      };
    },
    async *events(args, signal, peer) {
      const response = await fetch(request(args, signal, true), peer);
      if (response.status !== 200 || !response.headers.get('content-type')?.startsWith('text/event-stream')) {
        await response.body?.cancel();
        throw new ProtocolError('editor/events-refused');
      }
      try {
        yield { type: 'ready' };
        const decoder = new TextDecoder();
        let pending = '';
        for await (const chunk of chunks(response, signal)) {
          pending += decoder.decode(chunk, { stream: true });
          let end;
          while ((end = pending.indexOf('\n')) !== -1) {
            if (end > 1024 * 1024) throw new ProtocolError('editor/event-too-large');
            yield { type: 'line', line: pending.slice(0, end).replace(/\r$/, '') };
            pending = pending.slice(end + 1);
          }
          if (pending.length > 1024 * 1024) throw new ProtocolError('editor/event-too-large');
        }
        pending += decoder.decode();
        if (pending) yield { type: 'line', line: pending.replace(/\r$/, '') };
      } finally {
        await response.body?.cancel().catch(() => {});
      }
    },
  };
}
