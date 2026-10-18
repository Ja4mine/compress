import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { LLM } from '../src/ai/llm';
import { CompressSettings, DEFAULT_SETTINGS } from '../src/providers';

type Handler = (req: IncomingMessage, body: Record<string, unknown>, res: ServerResponse) => void;

async function serve(h: Handler): Promise<{ base: string; seen: Record<string, unknown>[]; headers: IncomingMessage['headers'][]; close: () => void }> {
  const seen: Record<string, unknown>[] = [];
  const headers: IncomingMessage['headers'][] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      seen.push(body);
      headers.push(req.headers);
      h(req, body, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, seen, headers, close: () => server.close() };
}

function settings(provider: string, baseUrl: string, model: string): CompressSettings {
  return { ...DEFAULT_SETTINGS, provider, profiles: { [provider]: { baseUrl, apiKey: 'test-key', model, askModel: '' } } };
}

test('OpenAI-compatible: JSON mode refused, then asked plainly; a fenced reply is parsed', async () => {
  const srv = await serve((req, body, res) => {
    if (body.response_format) { res.writeHead(400); return void res.end('{"error":"response_format not supported"}'); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '<think>…</think>```json\n{"units": [{"id": "U0", "sentences": ["你好。"]}]}\n```' } }] }));
  });
  try {
    const llm = new LLM(() => settings('custom', `${srv.base}/v1`, 'm-1'));
    const out = await llm.json<{ units: { sentences: string[] }[] }>({ task: 'translate', system: 'sys', messages: [{ role: 'user', content: 'go' }], schema: { type: 'object' } });
    assert.deepEqual(out.units[0].sentences, ['你好。']);
    assert.equal(srv.seen.length, 2);
    assert.ok(srv.seen[0].response_format, 'JSON mode asked for first');
    assert.ok(!srv.seen[1].response_format, 'then without it');
    assert.match(JSON.stringify(srv.seen[1].messages), /JSON Schema/);
    assert.equal(srv.headers[0].authorization, 'Bearer test-key');
  } finally { srv.close(); }
});

test('OpenAI-compatible: a streamed answer arrives piece by piece', async () => {
  const srv = await serve((req, body, res) => {
    assert.equal(body.stream, true);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const piece of ['结论：', '模型更快 ', '[P2]。']) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  try {
    const llm = new LLM(() => settings('custom', `${srv.base}/v1`, 'm-1'));
    const seen: string[] = [];
    const out = await llm.text({ task: 'ask', system: 's', messages: [{ role: 'user', content: 'q' }], onText: (t) => seen.push(t) });
    assert.equal(out, '结论：模型更快 [P2]。');
    assert.deepEqual(seen, ['结论：', '结论：模型更快 ', '结论：模型更快 [P2]。']);
  } finally { srv.close(); }
});

test('OpenAI-compatible: a bad key is reported in plain words', async () => {
  const srv = await serve((req, body, res) => { res.writeHead(401); res.end('{"error":"invalid api key"}'); });
  try {
    const llm = new LLM(() => ({ ...settings('custom', `${srv.base}/v1`, 'm-1'), stream: false }));
    await assert.rejects(llm.text({ task: 'quick', system: 's', messages: [{ role: 'user', content: 'q' }] }), /API Key 无效/);
  } finally { srv.close(); }
});

test('Anthropic: structured output and effort sent; text and stream read back', async () => {
  const msg = (text: string) => ({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text }],
    stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
  const srv = await serve((req, body, res) => {
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return void res.end(JSON.stringify(msg('{"section": {"takeaway": "t", "topic": "x"}, "units": []}')));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const ev = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    ev('message_start', { message: { ...msg(''), content: [], stop_reason: null } });
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    for (const t of ['Hello', ' world']) ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: t } });
    ev('content_block_stop', { index: 0 });
    ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } });
    ev('message_stop', {});
    res.end();
  });
  try {
    const llm = new LLM(() => settings('anthropic', srv.base, 'claude-opus-5-5'));
    const out = await llm.json<{ section: { takeaway: string } }>({ task: 'fold', system: 'sys', messages: [{ role: 'user', content: 'go' }], schema: { type: 'object', properties: {}, additionalProperties: false } });
    assert.equal(out.section.takeaway, 't');
    const req = srv.seen[0] as { output_config: { effort: string; format: { type: string } }; fallbacks?: unknown; model: string };
    assert.equal(req.model, 'claude-opus-5-5');
    assert.equal(req.output_config.effort, 'low');
    assert.equal(req.output_config.format.type, 'json_schema');
    assert.equal(req.fallbacks, undefined, 'no server-side fallback through a proxy');
    assert.equal(srv.headers[0]['x-api-key'], 'test-key');
    const seen: string[] = [];
    const text = await llm.text({ task: 'ask', system: 's', messages: [{ role: 'user', content: 'q' }], onText: (t) => seen.push(t) });
    assert.equal(text, 'Hello world');
    assert.deepEqual(seen, ['Hello', 'Hello world']);
    assert.equal((srv.seen[1] as { output_config: { effort: string } }).output_config.effort, 'medium');
  } finally { srv.close(); }
});

test('nothing is sent until a model is set up', async () => {
  const llm = new LLM(() => ({ ...DEFAULT_SETTINGS, profiles: { deepseek: { baseUrl: '', apiKey: '', model: 'deepseek-chat', askModel: '' } } }));
  assert.match(llm.ready() ?? '', /API Key/);
  await assert.rejects(llm.text({ task: 'quick', system: 's', messages: [{ role: 'user', content: 'q' }] }), /API Key/);
});
