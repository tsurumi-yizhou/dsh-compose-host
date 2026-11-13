#!/usr/bin/env node
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const prefix = resolve(process.argv[2] ?? '.');
const outputRoot = process.argv[3] ? resolve(process.argv[3]) : prefix;
const packages = join(import.meta.dirname, 'packages');
const compiler = fileURLToPath(new URL('./node_modules/typescript/bin/tsc', import.meta.url));
const options = {
  target: 'ES2022', module: 'ESNext',
  moduleResolution: 'Bundler', useDefineForClassFields: true,
  rewriteRelativeImportExtensions: true, noCheck: true,
};
function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
  });
}
// Compile from the profile's sources, resolving external contracts from the installed engine.
// Compile each package as a whole so imported const enums are inlined.
for (const directory of readdirSync(packages).sort()) {
  const source = join(packages, directory);
  const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  const installed = join(prefix, 'node_modules', manifest.name);
  const temporary = join(installed, '.compose-types');
  const compilerOptions = {
    ...options, rootDir: join(source, 'src'), outDir: temporary, allowJs: true,
    paths: { '*': [join(prefix, 'node_modules', '*')] },
  };
  const outputs = new Set([manifest.main]);
  function exported(value) {
    if (typeof value === 'string' && /^\.\/lib\/.*\.(?:js|mjs|cjs)$/.test(value) && !value.includes('*')) outputs.add(value);
    else if (value && typeof value === 'object') Object.values(value).forEach(exported);
  }
  exported(manifest.exports);
  try {
    mkdirSync(temporary, { recursive: true });
    const config = join(temporary, 'tsconfig.json');
    writeFileSync(config, JSON.stringify({ compilerOptions, files: sourceFiles(join(source, 'src')) }));
    execFileSync(process.execPath, [compiler, '--project', config], { stdio: 'inherit' });
    for (const output of outputs) {
      if (!output) continue;
      const entry = output.replace(/^\.\//, '').replace(/^lib\/(?:types\/)?/, '').replace(/\.(?:js|mjs|cjs)$/, '.js');
      const input = join(temporary, entry);
      // Generated protocol faces and the independent verifier retain their package build.
      if (!existsSync(input)) continue;
      const target = join(outputRoot, 'node_modules', manifest.name, output);
      mkdirSync(dirname(target), { recursive: true });
      await build({
        entryPoints: [input], outfile: target, bundle: true, packages: 'external',
        platform: 'node', target: 'node26', format: output.endsWith('.cjs') ? 'cjs' : 'esm',
        logLevel: 'warning',
      });
    }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
  mkdirSync(join(outputRoot, 'node_modules', manifest.name), { recursive: true });
  writeFileSync(join(outputRoot, 'node_modules', manifest.name, 'LICENSE'), readFileSync(join(source, 'LICENSE')));
  console.log(`compose source: ${manifest.name}`);
}
