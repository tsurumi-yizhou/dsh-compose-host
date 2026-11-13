import { ProtocolError } from './devices.mjs';

/** Bounded terminal input; cancellation releases a waiting engine iterator immediately. */
class Input {
  queue = [];
  bytes = 0;
  ended = false;
  wake;
  push(value) {
    if (this.ended) throw new ProtocolError('stream/closed');
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (this.bytes + bytes > 262144) throw new ProtocolError('stream/input-full');
    this.queue.push({ value, bytes });
    this.bytes += bytes;
    this.wake?.();
  }
  close(discard = false) {
    this.ended = true;
    if (discard) { this.queue = []; this.bytes = 0; }
    this.wake?.();
  }
  async *[Symbol.asyncIterator]() {
    while (true) {
      if (this.queue.length) {
        const item = this.queue.shift();
        this.bytes -= item.bytes;
        yield item.value;
      } else if (this.ended) return;
      else await new Promise(resolve => { this.wake = resolve; });
    }
  }
}

/** compose event protocol: subscribe/input/finish/cancel → event/complete/error. */
export function serveStreams(socket, device, gateway) {
  const streams = new Map();
  device.sockets.add(socket);
  let alive = true;
  const heartbeat = setInterval(() => {
    if (!alive) { socket.terminate(); return; }
    alive = false;
    socket.ping();
  }, 20000);
  heartbeat.unref();
  socket.on('pong', () => {
    try { gateway.renew(); alive = true; }
    catch { socket.close(1008, 'device/unauthorized'); }
  });
  const cancel = id => {
    const entry = streams.get(id);
    if (!entry) return;
    streams.delete(id);
    entry.control.abort();
    entry.input.close(true);
  };
  const send = frame => new Promise((resolve, reject) => {
    if (socket.readyState !== 1 || socket.bufferedAmount > 16 * 1024 * 1024) {
      socket.close(1013, 'stream/consumer-slow');
      reject(new ProtocolError('stream/consumer-slow'));
      return;
    }
    socket.send(JSON.stringify(frame), error => error ? reject(error) : resolve());
  });
  const subscribe = async frame => {
    const { id, method, args } = frame;
    if (streams.has(id) || streams.size >= 128) throw new ProtocolError('stream/unavailable');
    if (typeof method !== 'string' || method.length > 200 || !args || typeof args !== 'object' || Array.isArray(args))
      throw new ProtocolError('stream/invalid');
    const control = new AbortController();
    const input = new Input();
    const entry = { control, input };
    streams.set(id, entry);
    try {
      const signal = AbortSignal.any([control.signal, device.peer.signal]);
      const source = await gateway.open(method, { args }, input, device.peer, signal);
      for await (const value of source) {
        if (signal.aborted || streams.get(id) !== entry) break;
        await send({ op: 'event', id, data: value ?? null });
      }
      if (!signal.aborted && streams.get(id) === entry) await send({ op: 'complete', id });
    } catch (error) {
      if (!control.signal.aborted && streams.get(id) === entry) {
        await send({ op: 'error', id, error: gateway.failure(error) }).catch(() => {});
      }
    } finally {
      if (streams.get(id) === entry) streams.delete(id);
      control.abort();
      input.close(true);
    }
  };
  socket.on('message', (raw, binary) => {
    try { gateway.renew(); }
    catch { socket.close(1008, 'device/unauthorized'); return; }
    let frame;
    try {
      if (binary) throw new ProtocolError('stream/invalid');
      frame = JSON.parse(raw.toString('utf8'));
      if (!frame || typeof frame.id !== 'string' || !/^[\w-]{16,80}$/.test(frame.id))
        throw new ProtocolError('stream/invalid');
      switch (frame.op) {
        case 'subscribe':
          subscribe(frame).catch(error => {
            cancel(frame.id);
            return send({ op: 'error', id: frame.id, error: gateway.failure(error) }).catch(() => {});
          });
          break;
        case 'input': {
          const stream = streams.get(frame.id);
          if (!stream) throw new ProtocolError('stream/closed');
          stream.input.push(frame.data ?? null);
          break;
        }
        case 'finish': streams.get(frame.id)?.input.close(); break;
        case 'cancel': cancel(frame.id); break;
        default: throw new ProtocolError('stream/invalid');
      }
    } catch (error) {
      if (frame && typeof frame.id === 'string' && /^[\w-]{16,80}$/.test(frame.id)) {
        cancel(frame.id);
        send({ op: 'error', id: frame.id, error: { code: error.code ?? 'stream/invalid' } }).catch(() => {});
      } else socket.close(1008, 'stream/invalid');
    }
  });
  socket.once('close', () => {
    clearInterval(heartbeat);
    for (const id of streams.keys()) cancel(id);
    device.sockets.delete(socket);
  });
  socket.on('error', () => socket.terminate());
}
