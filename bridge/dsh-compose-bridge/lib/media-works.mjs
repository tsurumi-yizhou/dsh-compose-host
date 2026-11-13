import { constants } from 'node:fs';
import { opendir, open, realpath, lstat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, dirname, basename, isAbsolute } from 'node:path';

const ROOT = '/compose/extensions/v1/media/works';
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const RID = /^m_[a-f0-9-]{36}$/;
const KEY = /^(\d{4}-\d{2}-\d{2})\/(m_[a-f0-9-]{36})$/;
const failure = (code, status = 400) => Object.assign(new Error(code), { code, status });
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;

async function directory(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) throw failure('media/unsafe-path', 409);
  return info;
}
async function readRecord(root, key) {
  const match = KEY.exec(key);
  if (!match) throw failure('media/invalid-key');
  const date = match[1], rid = match[2], folder = join(root, date), path = join(folder, `${rid}.json`);
  await directory(root); const folderInfo = await directory(folder);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 17408) throw failure('media/invalid-record', 409);
    const buffer = Buffer.alloc(info.size + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== info.size) throw failure('media/record-changed', 409);
    const value = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
    if (value?.schemaVersion !== 1 || value.rid !== rid || typeof value.sessionId !== 'string'
      || !Number.isFinite(value.createdAt) || !isAbsolute(value.cwd ?? '') || !Array.isArray(value.media?.items)
      || value.media.items.length < 1 || value.media.items.length > 4) throw failure('media/invalid-record', 409);
    return { key, date, rid, folder, folderInfo, path, info, value };
  } finally { await file.close(); }
}

// Keep only this page's candidates while enumerating names. No complete work history or image bytes are loaded.
async function namesBefore(path, before, keep, predicate, limit) {
  const result = [];
  let entries;
  try { entries = await opendir(path); } catch (error) { if (error?.code === 'ENOENT') return result; throw error; }
  for await (const entry of entries) {
    if (!predicate(entry) || before !== null && entry.name >= before || !keep(entry.name)) continue;
    result.push(entry.name); result.sort((a, b) => b.localeCompare(a, 'en'));
    if (result.length > limit) result.pop();
  }
  return result;
}

export function createMediaWorks({ readBody, send, home = () => process.env.DSH_HOME?.trim() || join(homedir(), '.dsh') }) {
  const root = () => resolve(home(), 'media', 'dsh-media', 'works');
  return {
    async list({ cursor = null, limit = 40, kind = null } = {}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100 || cursor !== null && !KEY.test(cursor) || kind !== null && !['image', 'video'].includes(kind)) throw failure('media/invalid-query');
      const base = root();
      try { await directory(base); } catch (error) { if (error?.code === 'ENOENT') return { items: [], next: null }; throw error; }
      const cursorDate = cursor?.split('/')[0] ?? null, cursorFile = cursor ? `${cursor.split('/')[1]}.json` : null;
      const days = await namesBefore(base, null, name => cursorDate === null || name <= cursorDate, entry => entry.isDirectory() && DATE.test(entry.name), limit + 1);
      const items = [];
      let scanned = 0, last = cursor, exhausted = true;
      for (const day of days) {
        last = `${day}/m_00000000-0000-0000-0000-000000000000`;
        await directory(join(base, day));
        let before = day === cursorDate ? cursorFile : null;
        while (items.length < limit && scanned < 200) {
          const names = await namesBefore(join(base, day), before, () => true, entry => entry.isFile() && RID.test(entry.name.slice(0, -5)) && entry.name.endsWith('.json'), Math.min(101, 201 - scanned));
          if (names.length === 0) break;
          for (const name of names) {
            if (items.length >= limit || scanned >= 200) { exhausted = false; break; }
            scanned++; before = name; last = `${day}/${name.slice(0, -5)}`;
            const record = await readRecord(base, last);
            if (kind === null || record.value.media.kind === kind) items.push({ key: last, sessionId: record.value.sessionId, createdAt: record.value.createdAt, cwd: record.value.cwd, media: record.value.media });
          }
          if (names.length < 101) break;
        }
        if (items.length >= limit || scanned >= 200) { exhausted = false; break; }
      }
      if (days.length === limit + 1) exhausted = false;
      return { items, next: exhausted ? null : last };
    },
    async remove({ key, files, removeIndex }) {
      if (typeof key !== 'string' || !Array.isArray(files) || files.length < 1 || files.length > 8 || files.some(path => typeof path !== 'string') || removeIndex !== true) throw failure('media/invalid-delete');
      const record = await readRecord(root(), key);
      const expected = [...new Set(record.value.media.items.flatMap(item => [item.path, ...(typeof item.poster === 'string' ? [item.poster] : [])]))];
      if (new Set(files).size !== files.length || files.length !== expected.length || expected.some(path => !files.includes(path))) throw failure('media/delete-scope-changed', 409);
      const cwd = record.value.cwd, generated = join(cwd, 'generated'), folder = join(generated, record.date);
      await directory(cwd); await directory(generated); const folderInfo = await directory(folder);
      const targets = [];
      for (const path of expected) {
        if (!isAbsolute(path) || resolve(path) !== path || dirname(path) !== folder || !basename(path).startsWith(`${record.rid}-`)) throw failure('media/unsafe-path', 409);
        try {
          const info = await lstat(path);
          if (!info.isFile() || info.isSymbolicLink()) throw failure('media/unsafe-path', 409);
          targets.push({ path, info });
        } catch (error) { if (error?.code !== 'ENOENT') throw error; }
      }
      const generatedHandle = await open(folder, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      let indexHandle;
      const deleted = [];
      try {
        indexHandle = await open(record.folder, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        if (!sameFile(folderInfo, await generatedHandle.stat()) || !sameFile(record.folderInfo, await indexHandle.stat())) throw failure('media/file-changed', 409);
        // Anchor unlink to opened directories so a concurrent workspace rename cannot redirect a deletion.
        const generatedFd = `/proc/self/fd/${generatedHandle.fd}`, indexFd = `/proc/self/fd/${indexHandle.fd}`;
        for (const target of targets) {
          const anchored = join(generatedFd, basename(target.path));
          if (!sameFile(target.info, await lstat(anchored))) throw failure('media/file-changed', 409);
          await unlink(anchored); deleted.push(target.path);
        }
        const indexPath = join(indexFd, basename(record.path));
        if (!sameFile(record.info, await lstat(indexPath))) throw failure('media/record-changed', 409);
        await unlink(indexPath);
        return { deleted: true, key, files: expected, removedIndex: true };
      } catch (error) { throw Object.assign(failure(deleted.length ? 'media/partial-delete' : error?.code?.startsWith('media/') ? error.code : 'media/delete-failed', 409), { deletedFiles: deleted }); }
      finally { await generatedHandle.close(); if (indexHandle) await indexHandle.close(); }
    },
    async handle(req, res, path, url) {
      if (path !== ROOT && path !== `${ROOT}/delete`) return false;
      try {
        if (path === ROOT) {
          if (req.method !== 'GET') throw failure('media/method-not-allowed', 405);
          const limitText = url.searchParams.get('limit');
          send(res, 200, await this.list({ cursor: url.searchParams.get('cursor'), kind: url.searchParams.get('kind'), limit: limitText === null ? 40 : Number(limitText) }));
        } else {
          if (req.method !== 'POST') throw failure('media/method-not-allowed', 405);
          if (String(req.headers['content-type']).split(';', 1)[0].trim().toLowerCase() !== 'application/json') throw failure('media/content-type', 415);
          const body = JSON.parse((await readBody(req, 16384)).toString('utf8'));
          send(res, 200, await this.remove(body));
        }
      } catch (error) {
        req.resume();
        const code = error?.code?.startsWith('media/') ? error.code : error?.code === 'ENOENT' ? 'media/not-found' : 'media/request-failed';
        send(res, error?.status ?? (error?.code === 'ENOENT' ? 404 : 500), { error: { code, ...(error?.deletedFiles ? { deletedFiles: error.deletedFiles } : {}) } });
      }
      return true;
    },
  };
}
