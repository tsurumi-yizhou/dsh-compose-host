import { existsSync, readdirSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

const [source, home] = process.argv.slice(2);
mkdirSync(home, { recursive: true });
const root = realpathSync(home);

// Resolve existing parents before creating a skill directory. A user-owned link
// outside this home must receive the same protection as a user-owned SKILL.md.
function targetPath(path) {
  const missing = [];
  let parent = resolve(path);
  while (!existsSync(parent)) {
    missing.unshift(basename(parent));
    parent = dirname(parent);
  }
  return join(realpathSync(parent), ...missing);
}
function contained(path, directory) {
  const child = relative(directory, targetPath(path));
  return child !== '..' && !child.startsWith('../') && !isAbsolute(child);
}

for (const name of readdirSync(source).filter(name => existsSync(join(source, name, 'manifest.json')))) {
  const directory = join(root, 'skills', name);
  if (!contained(directory, root)) continue;
  const skill = join(directory, 'SKILL.md');
  if (existsSync(skill)) {
    const text = readFileSync(skill, 'utf8');
    const frontMatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
    if (!frontMatter?.split(/\r?\n/).some(line => line.trimStart().startsWith('# dsh-compose:managed'))) continue;
  }
  const files = Object.entries(JSON.parse(readFileSync(join(source, name, 'manifest.json'), 'utf8')).files);
  const paths = files.map(([, destination]) => join(directory, destination));
  if (paths.some(file => !contained(file, directory) || !contained(`${file}.pending`, directory))) continue;
  // Publish the entry point after its referenced pages and scripts.
  for (const [asset, destination] of files.sort((a, b) => Number(a[1] === 'SKILL.md') - Number(b[1] === 'SKILL.md'))) {
    const file = join(directory, destination);
    const content = readFileSync(join(source, name, asset));
    if (existsSync(file) && readFileSync(file).equals(content)) continue;
    mkdirSync(dirname(file), { recursive: true });
    const pending = `${file}.pending`;
    try {
      writeFileSync(pending, content);
      renameSync(pending, file);
    } finally {
      rmSync(pending, { force: true });
    }
  }
}
