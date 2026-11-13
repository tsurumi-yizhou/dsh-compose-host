const ORIGIN = 'https://api.deepseek.com';
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_TEXT = 60000;

export function webUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Expected an HTTP or HTTPS URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || value.length > 8192) {
    throw new Error('Expected an HTTP or HTTPS URL without credentials, at most 8192 characters.');
  }
  return url.href;
}

export function boundedText(text) {
  return text.length <= MAX_TEXT ? text : text.slice(0, MAX_TEXT) + '\n\n[Output truncated; ask a narrower question.]';
}

function source(item) {
  try {
    return { url: webUrl(item.url), title: item.title || item.url,
      snippet: item.snippet || '', publishedAt: item.date || item.published_at || '' };
  } catch { return undefined; }
}

export function sourceLinks(sources) {
  return sources.map(item => `- [${item.title.replace(/[\\[\]\r\n]/g, ' ')}](<${item.url.replaceAll('>', '%3E')}>)`).join('\n');
}

/** Each operation captures one credential. Requests never follow redirects or retry paid work. */
export function createResearchClient(apiKey, request = globalThis.fetch) {
  async function call(path, { body, signal, method = 'POST', timeout = 300000 } = {}) {
    const combined = AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(timeout)]);
    combined.throwIfAborted();
    const multipart = body instanceof FormData;
    const response = await request(ORIGIN + path, {
      method, redirect: 'error', signal: combined,
      headers: { Authorization: `Bearer ${apiKey}`, ...(multipart ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: multipart ? body : JSON.stringify(body) }),
    });
    const reader = response.body?.getReader();
    let size = 0;
    const parts = [];
    try {
      if (reader) for (;;) {
        combined.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) throw new Error('DeepSeek response exceeds 32 MiB. Use a smaller document or narrower question.');
        parts.push(value);
      }
    } finally {
      await reader?.cancel().catch(() => {});
    }
    combined.throwIfAborted();
    let data;
    try { data = JSON.parse(Buffer.concat(parts).toString('utf8')); }
    catch { throw new Error(`DeepSeek returned an unreadable response (HTTP ${response.status}).`); }
    if (!response.ok || data.error) {
      const detail = typeof data.error?.message === 'string' ? data.error.message.replaceAll(apiKey, '[redacted]').slice(0, 500) : 'Request failed';
      throw new Error(`DeepSeek (HTTP ${response.status}): ${detail}`);
    }
    return data;
  }

  async function answer(content, signal, research = false) {
    const response = await call('/chat/completions', { signal, body: {
      model: 'deepseek-flash', stream: false, max_tokens: 8192,
      thinking: { type: research ? 'enabled' : 'disabled' },
      ...(research ? { tools: [{ type: 'deepseek_web_search' }, { type: 'deepseek_read_url' }] } : {}),
      messages: [{ role: 'user', content }],
    } });
    const choice = response.choices?.[0];
    if (!choice) throw new Error('DeepSeek returned no answer.');
    if (choice.finish_reason === 'content_filter') throw new Error('DeepSeek declined this request.');
    if (typeof choice.message?.content !== 'string') throw new Error('DeepSeek returned no answer.');
    if (!['stop', 'length'].includes(choice.finish_reason)) throw new Error('DeepSeek did not finish the answer.');
    const message = choice.message;
    const sources = new Map();
    for (const annotation of message.annotations ?? []) {
      const item = source(annotation.url_citation ?? {});
      if (item) sources.set(item.url, item);
    }
    for (const step of message.server_tool_calls ?? []) for (const action of step.calls ?? []) {
      for (const candidate of [...(action.sources ?? []), ...(action.page ? [action.page] : [])]) {
        const item = source(candidate);
        if (item && !sources.has(item.url)) sources.set(item.url, item);
      }
    }
    const truncated = choice.finish_reason === 'length' || message.content.length > MAX_TEXT;
    return { text: boundedText(message.content) + (choice.finish_reason === 'length' ? '\n\n[Answer reached the output limit.]' : ''),
      sources: [...sources.values()], truncated, usage: response.usage ?? {},
      // Preserve server actions, citations and signatures in the durable tool result.
      message };
  }

  return {
    async search(queries, signal) {
      if (!Array.isArray(queries) || !queries.length || queries.length > 4 ||
          queries.some(q => typeof q !== 'string' || !q.trim() || [...q].length > 128)) {
        throw new Error('Provide 1–4 non-empty search queries, each at most 128 characters.');
      }
      const sources = new Map();
      const summaries = [];
      // Sequential dispatch avoids abandoning sibling paid requests on error or cancellation.
      for (const query of new Set(queries)) {
        const response = await call('/v1/tools/search', { signal, timeout: 60000, body: { query, count: 8, need_content: false } });
        if (!Array.isArray(response.results)) throw new Error('DeepSeek returned no search result list.');
        for (const result of response.results) {
          const item = source(result);
          if (!item || sources.has(item.url)) continue;
          sources.set(item.url, item);
          summaries.push(`${sourceLinks([item])}\n${String(result.summary || result.snippet || '').slice(0, 2000)}`);
        }
      }
      const text = summaries.join('\n\n') || 'No search results.';
      return { text: boundedText(text), sources: [...sources.values()], truncated: text.length > MAX_TEXT };
    },
    async fetch(url, signal) {
      url = webUrl(url);
      const data = await call('/v1/tools/fetch', { signal, timeout: 60000, body: { url } });
      if (typeof data.content !== 'string') throw new Error('DeepSeek returned no page content.');
      return { text: boundedText(data.content), sources: [{ url, title: data.title || url }], truncated: data.content.length > MAX_TEXT };
    },
    research(question, signal) {
      if (!question.trim()) throw new Error('A research question is required.');
      return answer(question, signal, true);
    },
    async ocr(file, purpose, signal) {
      const body = new FormData();
      body.append('purpose', purpose);
      body.append('file', file.blob, file.name);
      const data = await call('/v1/tools/ocr', { body, signal, timeout: 190000 });
      if (!Array.isArray(data.pages) || data.pages.some(page => typeof page.text !== 'string')) throw new Error('DeepSeek returned no OCR pages.');
      const text = data.pages.map(page => `## Page ${page.index + 1}${page.finish_reason === 'length' ? ' (incomplete)' : ''}\n${page.text}`).join('\n\n');
      return { text: boundedText(text), sources: [], truncated: text.length > MAX_TEXT || data.pages.some(p => p.finish_reason === 'length'),
        pageCount: data.page_count, usage: data.usage ?? {} };
    },
    async document(file, purpose, question, signal) {
      if (!question.trim()) throw new Error('A document question is required.');
      const body = new FormData();
      body.append('purpose', purpose);
      body.append('expires_after[anchor]', 'created_at');
      body.append('expires_after[seconds]', '3600');
      body.append('file', file.blob, file.name);
      const uploaded = await call('/files', { body, signal });
      if (typeof uploaded.id !== 'string' || !/^file-[a-zA-Z0-9_-]+$/.test(uploaded.id)) throw new Error('DeepSeek returned no file ID.');
      let result;
      try {
        result = await answer([{ type: 'file', file_id: uploaded.id }, { type: 'text', text: question }], signal);
        return result;
      } finally {
        // Remove only this invocation's upload; expiry also covers interrupted cleanup.
        try { await call('/files/' + uploaded.id, { method: 'DELETE', timeout: 10000 }); }
        catch { if (result) result.text += '\n\n[Temporary cloud file cleanup failed; it expires one hour after upload.]'; }
      }
    },
  };
}
