import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createProvider } from '../src/providers.js';
async function fixture(t, replies) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ path: req.url, body: JSON.parse(body), headers: req.headers });
    const reply = replies.shift();
    if (reply === 'hang') return;
    res.writeHead(typeof reply.status === 'number' ? reply.status : 200, { 'content-type': 'application/json' });
    res.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? reply));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { requests, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}
const request = { system: 'Be useful', messages: [{ role: 'user', content: 'Read file' }], tools: [{ name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }] };
const tool = { role: 'tool', toolCallId: 'c1', name: 'read', content: 'hello', isError: false };
test('OpenAI preserves reasoning/tool output and falls back to canonical history on model change', async t => {
  const output = [{ type: 'reasoning', id: 'r1', summary: [], encrypted_content: 'opaque' }, { type: 'function_call', id: 'fc1', call_id: 'c1', name: 'read', arguments: '{"path":"a"}' }];
  const f = await fixture(t, [{ status: 'completed', output, usage: { input_tokens: 4, output_tokens: 5 } }, { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'hello' }] }] }, { status: 'completed', output: [] }]);
  const p = createProvider({ provider: 'openai', model: 'test', apiKey: 'test', ...f });
  const first = await p.complete(request);
  assert.equal(first.message.toolCalls[0].arguments.path, 'a');
  assert.deepEqual(first.usage, { inputTokens: 4, outputTokens: 5 });
  const history = { ...request, messages: [...request.messages, first.message, tool] };
  assert.equal((await p.complete(history)).message.content, 'hello');
  assert.deepEqual(f.requests[1].body.input.slice(1, 3), output);
  assert.equal(f.requests[1].body.input.at(-1).call_id, 'c1');
  await createProvider({ provider: 'openai', model: 'other', apiKey: 'test', ...f }).complete(history);
  assert.equal(f.requests[2].body.input.some(x => x.type === 'reasoning'), false);
  assert.equal(f.requests[0].path, '/v1/responses');
  assert.equal(f.requests[0].body.tools[0].strict, false);
});
test('Anthropic preserves native thinking and groups consecutive tool results', async t => {
  const content = [{ type: 'thinking', thinking: 'native', signature: 'sig' }, { type: 'tool_use', id: 'c1', name: 'read', input: { path: 'a' } }];
  const f = await fixture(t, [{ content, stop_reason: 'tool_use' }, { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' }]);
  const p = createProvider({ provider: 'anthropic', model: 'test', apiKey: 'test', ...f });
  const first = await p.complete(request);
  const second = await p.complete({ ...request, messages: [...request.messages, first.message, tool, { ...tool, toolCallId: 'c2' }] });
  assert.equal(second.message.content, 'done');
  assert.deepEqual(f.requests[1].body.messages[1].content, content);
  assert.equal(f.requests[1].body.messages[2].content.length, 2);
  assert.equal(f.requests[0].headers['anthropic-version'], '2023-06-01');
});
test('Compatible provider local tool roundtrip retains native reasoning fields', async t => {
  const message = { role: 'assistant', content: null, reasoning_content: 'native', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } }] };
  const f = await fixture(t, [{ choices: [{ message, finish_reason: 'tool_calls' }] }, { choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }] }]);
  const p = createProvider({ provider: 'openai-compatible', model: 'local', ...f });
  const first = await p.complete(request);
  await p.complete({ ...request, messages: [...request.messages, first.message, tool] });
  assert.deepEqual(f.requests[1].body.messages[2], message);
  assert.equal(f.requests[1].body.messages[3].tool_call_id, 'c1');
  assert.equal(f.requests[0].path, '/v1/chat/completions');
});
test('Malformed tool arguments never become executable calls', async t => {
  for (const args of ['{', '[]', 'null']) {
    const f = await fixture(t, [{ status: 'completed', output: [{ type: 'function_call', call_id: 'c1', name: 'read', arguments: args }] }]);
    await assert.rejects(createProvider({ provider: 'openai', model: 'test', apiKey: 'test', ...f }).complete(request), /tool argument/);
  }
});
test('HTTP and JSON errors do not expose upstream response bodies', async t => {
  const f = await fixture(t, [{ status: 401, body: 'SECRET' }, { body: 'SECRET' }, { body: {} }]);
  const p = createProvider({ provider: 'openai', model: 'test', apiKey: 'SECRET', ...f });
  await assert.rejects(p.complete(request), { message: 'Provider HTTP 401' });
  await assert.rejects(p.complete(request), { message: 'Provider returned invalid JSON' });
  await assert.rejects(p.complete(request), { message: 'Malformed provider response' });
});
test('Requests have bounded timeout and caller cancellation', async t => {
  const f = await fixture(t, ['hang', 'hang']);
  await assert.rejects(createProvider({ provider: 'openai-compatible', model: 'test', timeoutMs: 30, ...f }).complete(request), /timed out/);
  const controller = new AbortController();
  const pending = createProvider({ provider: 'openai-compatible', model: 'test', ...f }).complete({ ...request, signal: controller.signal });
  controller.abort('private abort detail');
  await assert.rejects(pending, { message: 'Provider request cancelled' });
});
test('Configuration is validated and demo completes offline', async () => {
  assert.throws(() => createProvider({ provider: 'wrong', model: 'test' }), /Unknown provider/);
  assert.throws(() => createProvider({ provider: 'openai-compatible', model: 'test' }), /requires baseUrl/);
  assert.throws(() => createProvider({ provider: 'demo', model: 'demo', timeoutMs: -1 }), /timeoutMs/);
  const output = await createProvider({ provider: 'demo', model: 'demo' }).complete(request);
  assert.match(output.message.content, /offline demo/);
});
