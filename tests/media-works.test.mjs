import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createMediaWorks } from '../bridge/dsh-compose-bridge/lib/media-works.mjs';

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'media-works-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, 'host'), cwd = join(base, 'workspace');
  const api = createMediaWorks({ home: () => home, readBody: async () => Buffer.alloc(0), send() {} });
  async function work(date, number, kind = 'image') {
    const rid = `m_${randomUUID()}`, folder = join(cwd, 'generated', date), index = join(home, 'media', 'dsh-media', 'works', date);
    await mkdir(folder, { recursive: true }); await mkdir(index, { recursive: true });
    const path = join(folder, `${rid}-1.${kind === 'video' ? 'mp4' : 'png'}`);
    await writeFile(path, `content-${number}`);
    const media = { v: 1, rid, kind, status: 'done', prompt: 'A picture', items: [{ path, mime: `${kind}/${kind === 'video' ? 'mp4' : 'png'}` }] };
    const record = { schemaVersion: 1, rid, sessionId: `session-${number}`, createdAt: number, cwd, media };
    await writeFile(join(index, `${rid}.json`), JSON.stringify(record));
    return { key: `${date}/${rid}`, path, index: join(index, `${rid}.json`), media };
  }
  return { api, work, base, home, cwd };
}

test('work history pages only metadata, with stable cursors and kind filtering', async t => {
  const { api, work } = await fixture(t);
  const expected = [];
  for (let index = 0; index < 9; index++) expected.push(await work(index < 4 ? '2026-11-06' : '2026-11-07', index, index % 2 ? 'video' : 'image'));
  const received = [];
  let cursor = null;
  do {
    const page = await api.list({ cursor, limit: 2 });
    assert.ok(page.items.length <= 2);
    received.push(...page.items.map(row => row.key)); cursor = page.next;
  } while (cursor !== null);
  assert.equal(new Set(received).size, expected.length);
  assert.deepEqual(new Set(received), new Set(expected.map(row => row.key)));
  const videos = await api.list({ kind: 'video', limit: 100 });
  assert.equal(videos.items.length, 4);
  assert.ok(videos.items.every(row => row.media.kind === 'video' && !Object.hasOwn(row, 'contentDigests')));
});

test('deletion requires the exact confirmed work files and preserves unrelated files', async t => {
  const { api, work, base } = await fixture(t);
  const selected = await work('2026-11-07', 1), unrelated = await work('2026-11-07', 2);
  await assert.rejects(api.remove({ key: selected.key, files: [selected.path, unrelated.path], removeIndex: true }), { code: 'media/delete-scope-changed' });
  await assert.rejects(api.remove({ key: '../credentials', files: [selected.path], removeIndex: true }), { code: 'media/invalid-key' });
  await access(selected.path); await access(selected.index);
  const result = await api.remove({ key: selected.key, files: [selected.path], removeIndex: true });
  assert.equal(result.deleted, true); assert.deepEqual(result.files, [selected.path]);
  await assert.rejects(access(selected.path), { code: 'ENOENT' }); await assert.rejects(access(selected.index), { code: 'ENOENT' });
  assert.equal(await readFile(unrelated.path, 'utf8'), 'content-2');
  const unsafe = await work('2026-11-07', 3), outside = join(base, 'outside.png');
  await writeFile(outside, 'must remain'); await rm(unsafe.path); await symlink(outside, unsafe.path);
  await assert.rejects(api.remove({ key: unsafe.key, files: [unsafe.path], removeIndex: true }), { code: 'media/unsafe-path' });
  assert.equal(await readFile(outside, 'utf8'), 'must remain'); await access(unsafe.index);
});
