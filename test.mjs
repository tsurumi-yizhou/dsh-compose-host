#!/usr/bin/env node
import { globSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('./', import.meta.url));
// Profile behavior is owned here; regression tests for upstream fixes are not part of this suite.
const groups = [
  'bridge-*', 'compose-*', 'config-editor-writable', 'default-model',
  'deletion-durability', 'loader-remove-nested', 'media-works', 'native-*',
  'plugin-config*', 'secret-callback-schema', 'session-deletion-*', 'session-lifecycle-enumeration',
];
const paths = groups.flatMap(group => [...globSync(`tests/${group}.test.mjs`, { cwd: root })]);
paths.push(...globSync('deploy/*.test.mjs', { cwd: root }));
process.env.DSH_PREFIX ??= root + '.work/dependencies';
process.env.DSH_TEST_PREFIX ??= process.env.DSH_PREFIX;
process.env.DSH_INSTALL ??= process.env.DSH_PREFIX + '/node_modules/@deepseek-ai/dsh';
process.env.DSH_TOOLS_DIR ??= process.env.DSH_PREFIX + '/node_modules/@deepseek-ai/dsh-tools';
const result = spawnSync(process.execPath, ['--test', ...new Set(paths)], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
