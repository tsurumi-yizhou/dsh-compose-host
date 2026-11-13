import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEditor } from '../bundles/dsh-compose-app/lib/protocol/editor.mjs';

function editor(fetch) {
  return createEditor({
    webServer: { getOrigin: () => 'http://127.0.0.1:3080' },
    connection: { createSharedFetchHandler: () => ({ fetch }) },
  });
}

test('editor writes preserve bytes and the admitted device without exposing credentials to the renderer', async () => {
  const peer = { principal: { kind: 'owner' } };
  const control = new AbortController();
  const bytes = Buffer.from([0, 127, 128, 255]);
  const api = editor(async (request, admitted) => {
    assert.equal(admitted, peer);
    assert.equal(request.url, 'http://127.0.0.1:3080/api/editor/save');
    assert.equal(request.method, 'PUT');
    assert.equal(request.headers.get('authorization'), null);
    assert.equal(request.headers.get('cookie'), null);
    assert.deepEqual(Buffer.from(await request.arrayBuffer()), bytes);
    return new Response(bytes, { status: 201, headers: { 'content-type': 'application/octet-stream', 'set-cookie': 'private', etag: 'revision' } });
  });
  const result = await api.request({ path: '/api/editor/save', method: 'PUT', body: bytes.toString('base64'), headers: { authorization: 'private', cookie: 'private' } }, control.signal, peer);
  assert.equal(result.status, 201);
  assert.deepEqual(Buffer.from(result.body, 'base64'), bytes);
  assert.deepEqual(result.headers, { 'content-type': 'application/octet-stream', etag: 'revision' });
});

test('editor event subscription preserves UTF-8 lines and releases its reader on device cancellation', async () => {
  let cancelled = false;
  const data = new TextEncoder().encode('event: change\r\ndata: 中文\n\n');
  const control = new AbortController();
  const api = editor(async () => new Response(new ReadableStream({
    start(stream) {
      stream.enqueue(data.slice(0, 23));
      stream.enqueue(data.slice(23));
    },
    cancel() { cancelled = true; },
  }), { headers: { 'content-type': 'text/event-stream' } }));
  const source = api.events({ path: '/api/editor/events' }, control.signal, {});
  assert.deepEqual((await source.next()).value, { type: 'ready' });
  assert.deepEqual((await source.next()).value, { type: 'line', line: 'event: change' });
  assert.deepEqual((await source.next()).value, { type: 'line', line: 'data: 中文' });
  assert.deepEqual((await source.next()).value, { type: 'line', line: '' });
  const waiting = source.next();
  control.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
  assert.equal(cancelled, true);
  cancelled = false;
  const unopened = api.events({ path: '/api/editor/events' }, new AbortController().signal, {});
  await unopened.next();
  await unopened.return();
  assert.equal(cancelled, true);
});
