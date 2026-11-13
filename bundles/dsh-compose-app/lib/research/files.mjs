import { openAsBlob } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path';

const RECOGNITION = new Set(['.pdf', '.doc', '.docx', '.ppt', '.pptx', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff']);
const USER_DATA = new Set(['.txt', '.md', '.csv', '.json', '.xml', '.html', '.js', '.ts', '.py', '.java', '.kt', '.c', '.h', '.cpp', '.css', '.yaml', '.yml', '.log', '.xlsx', '.xls', '.epub', '.mobi']);

/** Resolve only this conversation's attachments or a file within its working directory. */
export async function researchFile(ctx, exec, selector, mode, ocr = false) {
  if (!exec.agent) throw new Error('File tools require a conversation.');
  exec.signal.throwIfAborted();
  const refs = new Map();
  for (const event of exec.agent.session.snapshotEvents()) {
    if (event.type !== 'user/message') continue;
    for (const block of event.data.content ?? []) {
      if (block.type !== 'file' && block.type !== 'image') continue;
      const ref = block.attachment;
      if (!ref) continue;
      const path = block.type === 'file' ? ctx.attachments.fileHostPath(ref) : ctx.attachments.imageHostPath(ref);
      if (path) {
        refs.delete(ref.attachmentId);
        refs.set(ref.attachmentId, { ref, path });
      }
    }
  }
  let selected;
  if (!selector) selected = [...refs.values()].at(-1);
  else {
    const matches = [...refs.values()].filter(({ ref, path }) => selector === ref.attachmentId || selector === ref.name || selector === path);
    if (matches.length > 1) throw new Error('Multiple attachments have this name; use the attachment ID or exact path.');
    selected = matches[0];
  }
  let path, name;
  if (selected) {
    path = await realpath(selected.path);
    name = selected.ref.name || basename(path);
  } else {
    if (!selector) throw new Error('Attach a document or image, or specify a workspace file.');
    const root = await realpath(await ctx.workingDirectory.ensure(exec.agent, exec.signal));
    path = await realpath(resolve(root, selector));
    const inside = relative(root, path);
    if (inside === '..' || inside.startsWith('..' + sep) || isAbsolute(inside)) {
      throw new Error('Choose an attachment from this conversation or a file inside its workspace.');
    }
    name = basename(path);
  }
  const extension = extname(name).toLowerCase();
  if (!RECOGNITION.has(extension) && (ocr || !USER_DATA.has(extension))) {
    throw new Error(ocr ? 'OCR accepts PDF, Word, PowerPoint and images.' : 'Unsupported document format.');
  }
  const purpose = RECOGNITION.has(extension) ? mode : 'user_data';
  const limit = purpose === 'user_data' ? 32 * 1024 * 1024 : 100 * 1024 * 1024;
  const info = await stat(path);
  if (!info.isFile() || info.size === 0 || info.size > limit) throw new Error(`Choose a non-empty regular file up to ${limit / 1024 / 1024} MiB.`);
  exec.signal.throwIfAborted();
  return { file: { name, blob: await openAsBlob(path) }, purpose };
}
