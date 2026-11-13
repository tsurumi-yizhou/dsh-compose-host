import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire, registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { createResearchClient } from '../bundles/dsh-compose-app/lib/research/client.mjs';
import { researchFile } from '../bundles/dsh-compose-app/lib/research/files.mjs';

const bundle = new URL('../bundles/dsh-compose-app/', import.meta.url);
const prefix = process.env.DSH_TEST_PREFIX ?? process.env.DSH_PREFIX;
if (!prefix) throw new Error('DSH_TEST_PREFIX must point to the prepared engine');
const installed = pathToFileURL(resolve(prefix, 'node_modules/@deepseek-ai/dsh-web-app') + '/');
const requireInstalled = createRequire(new URL('package.json', installed));
registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL?.startsWith(bundle.href) && !specifier.startsWith('.') && !specifier.startsWith('node:')) {
    return nextResolve(specifier, { ...context, parentURL: new URL('lib/index.js', installed).href });
  }
  return nextResolve(specifier, context);
} });
const toolsPlugin = await import(new URL('lib/research/tools.mjs', bundle));
const settingsPlugin = await import(new URL('lib/research/settings.mjs', bundle));
const yaml = requireInstalled('yaml');
const yamlSchema = { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] };
const signal = () => new AbortController().signal;
const reply = (content, extra = {}) => Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content, ...extra } }], usage: { total_tokens: 12 } });

function harness(client) {
  const definitions = new Map(), conditions = new Map(), prompts = [];
  const ctx = {
    composeResearch: { enabled: () => true, client: async () => client },
    tools: { register(tool, options) { definitions.set(tool.name, tool); conditions.set(tool.name, options.when); }, get: name => definitions.get(name) },
    systemPrompt: { getSectionOrder: () => 1, section: section => prompts.push(section) },
  };
  toolsPlugin.apply(ctx);
  return { ctx, definitions, conditions, prompts };
}

test('search, page reading and thinking research run through registered tools with durable citations', async () => {
  const seen = [];
  const client = createResearchClient('test-key', async (url, init) => {
    assert.equal(init.headers.Authorization, 'Bearer test-key');
    assert.equal(init.redirect, 'error');
    const body = JSON.parse(init.body); seen.push({ url, body });
    if (url.endsWith('/search')) return Response.json({ results: [{ url: 'https://example.com/report', title: 'Report', summary: 'The result is 42.' }] });
    if (url.endsWith('/fetch')) return Response.json({ title: 'Report', content: '# Full report\n42' });
    assert.equal(body.thinking.type, 'enabled');
    assert.deepEqual(body.tools, [{ type: 'deepseek_web_search' }, { type: 'deepseek_read_url' }]);
    return reply('Research answer', {
      annotations: [{ type: 'url_citation', url_citation: { url: 'https://example.com/report', title: 'Report' } }],
      server_tool_calls: [{ index: 0, calls: [{ id: 'srvtoolu_1', kind: 'read_link', status: 'completed', signature: 'opaque-signature', page: { url: 'https://example.com/report', title: 'Report' } }] }],
    });
  });
  const { definitions, ctx } = harness(client);
  const exec = { signal: signal() };
  const searched = await definitions.get('web_search').execute({ queries: ['question'] }, exec);
  assert.match(searched.text, /42/);
  const page = await definitions.get('web_fetch').execute({ url: searched.sources[0].url }, exec);
  assert.match(page.text, /Full report/);
  const tool = definitions.get('deep_research');
  const value = await tool.execute({ question: 'Compare the evidence' }, exec);
  const meta = JSON.parse(JSON.stringify(tool.output.presentationMeta({}, value)));
  assert.equal(meta.message.server_tool_calls[0].calls[0].signature, 'opaque-signature');
  assert.equal(tool.presentResult({ question: 'Compare' }, { meta }).sources[0].url, 'https://example.com/report');
  assert.match(tool.output.render({}, value)[0].text, /https:\/\/example.com\/report/);
  ctx.composeResearch.enabled = () => false;
  await assert.rejects(tool.execute({ question: 'No request' }, exec), /disabled/);
  assert.equal(seen.length, 3);
});

test('document and OCR use conversation attachments, ordered multipart fields and cloud cleanup', async t => {
  const root = await mkdtemp(join(tmpdir(), 'compose-research-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'report.pdf'); await writeFile(path, '%PDF-test');
  const ref = { attachmentId: 'attached-report', name: 'report.pdf', bytes: 9 };
  const exec = { signal: signal(), agent: { session: { snapshotEvents: () => [{ type: 'user/message', data: { content: [{ type: 'file', attachment: ref }] } }] } } };
  const calls = [];
  const client = createResearchClient('key', async (url, init) => {
    calls.push(url);
    if (url.endsWith('/files') || url.endsWith('/ocr')) {
      assert.equal([...init.body.keys()][0], 'purpose');
      assert.equal(await init.body.get('file').text(), '%PDF-test');
      if (url.endsWith('/files')) {
        assert.equal(init.body.get('purpose'), 'rich_layout_recognition');
        assert.equal(init.body.get('expires_after[seconds]'), '3600');
        return Response.json({ id: 'file-api-document' });
      }
      assert.equal(init.body.get('purpose'), 'text_recognition');
      return new Response('\n\n' + JSON.stringify({ page_count: 2, pages: [{ index: 0, text: 'First', finish_reason: 'stop' }, { index: 1, text: 'Second', finish_reason: 'length' }] }));
    }
    if (init.method === 'DELETE') return Response.json({ deleted: true });
    const body = JSON.parse(init.body);
    assert.deepEqual(body.messages[0].content[0], { type: 'file', file_id: 'file-api-document' });
    return reply('A chart shows growth.');
  });
  const { definitions, ctx } = harness(client);
  ctx.attachments = { fileHostPath: () => path };
  ctx.workingDirectory = { ensure: async () => root };
  const value = await definitions.get('parse_document').execute({ question: 'Explain the chart' }, exec);
  assert.equal(value.text, 'A chart shows growth.');
  assert.equal(calls.at(-1), 'https://api.deepseek.com/files/file-api-document');
  const recognized = await definitions.get('ocr').execute({ file: 'report.pdf' }, exec);
  assert.match(recognized.text, /Page 2 \(incomplete\)/);
  assert.equal(recognized.truncated, true);
  const outside = await mkdtemp(join(tmpdir(), 'compose-private-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'secret.pdf'), 'private');
  await symlink(join(outside, 'secret.pdf'), join(root, 'outside.pdf'));
  await assert.rejects(researchFile(ctx, exec, 'outside.pdf', 'text_recognition'), /inside its workspace/);
  await writeFile(join(root, 'sheet.xlsx'), 'sheet');
  assert.equal((await researchFile(ctx, exec, 'sheet.xlsx', 'rich_layout_recognition')).purpose, 'user_data');
});

test('provider failures and cancellation are reported without retrying paid work', async () => {
  let count = 0;
  const client = createResearchClient('key', async () => {
    count++;
    return Response.json({ error: { message: 'OCR did not finish in time' } });
  });
  await assert.rejects(client.ocr({ name: 'test.pdf', blob: new Blob(['pdf']) }, 'text_recognition', signal()), /OCR did not finish/);
  assert.equal(count, 1);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(client.search(['query'], abort.signal), { name: 'AbortError' });
  assert.equal(count, 1);
  const calls = [];
  const failingDocument = createResearchClient('key', async (url, init) => {
    calls.push(init.method);
    if (url.endsWith('/files')) return Response.json({ id: 'file-api-failed' });
    if (init.method === 'DELETE') return Response.json({ deleted: true });
    return Response.json({ error: { message: 'Insufficient balance' } }, { status: 402 });
  });
  await assert.rejects(failingDocument.document({ name: 'test.pdf', blob: new Blob(['pdf']) }, 'text_recognition', 'Summarize', signal()), /402/);
  assert.deepEqual(calls, ['POST', 'POST', 'DELETE']);
});

test('profile presets mount the research tools and settings resolve the existing credential reference', async () => {
  const packageJson = JSON.parse(readFileSync(new URL('package.json', bundle)));
  assert.equal(packageJson.exports['./research-tools'], './lib/research/tools.mjs');
  const rows = yaml.parse(readFileSync(new URL('cordis.patch.yml', bundle), 'utf8'), yamlSchema);
  assert.ok(rows.flatMap(row => row.insert ?? []).some(row => row.id === 'compose-research' && row.name === 'dsh-compose-app/research'));
  for (const preset of ['standard', 'minimal', 'ptc', 'cordis']) {
    const [row] = yaml.parse(readFileSync(new URL(`presets/${preset}.patch.yml`, bundle), 'utf8'), yamlSchema);
    const plugins = row.insert[0].config.plugins;
    assert.equal(plugins.filter(plugin => plugin.name === 'dsh-compose-app/research-tools').length, 1);
    assert.equal(plugins.filter(plugin => plugin.name === '@deepseek-ai/dsh-tool-web').length, 0);
  }
  const config = settingsPlugin.Config({});
  let service;
  const ctx = { provide(_name, value) { service = value; }, credentials: { async resolve(ref) {
    assert.equal(ref, 'DEEPSEEK_API_KEY'); return undefined;
  } } };
  settingsPlugin.apply(ctx, config);
  assert.equal(service.enabled('documents'), true);
  await assert.rejects(service.client(), /Configure a DeepSeek API key/);
});
