import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../src/agent.js';
const call = (id = '1', name = 'echo') => ({ id, name, arguments: { value: 'hi' } });
const answer = (toolCalls, finishReason = toolCalls ? 'tool_calls' : 'stop') => ({ message: { role: 'assistant', content: toolCalls ? 'Working' : 'Done', ...(toolCalls ? { toolCalls } : {}), opaque: { token: 'preserved' } }, finishReason });
const provider = (...responses) => ({ id: 'fake', model: 'test', async complete() { return responses.shift(); } });
const echo = { name: 'echo', description: 'Echo', parameters: { type: 'object' }, async execute(args) { return args.value; } };

test('multiple turns preserve messages, calls, opaque data and event ordering', async () => {
  const events = [];
  const agent = new Agent({ provider: provider(answer([call()]), answer(), answer()), tools: [{ ...echo, async execute() { assert.equal(events.at(-1).type, 'tool_start'); return 'hi'; } }], onEvent: async e => { events.push(e); } });
  assert.equal((await agent.run('First')).status, 'completed');
  assert.equal((await agent.run('Second')).status, 'completed');
  assert.deepEqual(agent.messages.map(m => m.role), ['user', 'assistant', 'tool', 'assistant', 'user', 'assistant']);
  assert.equal(agent.messages[1].opaque.token, 'preserved');
  assert.equal(agent.messages[2].toolCallId, '1');
});

test('tool failures and unknown tools return explicit errors and allow recovery', async () => {
  const agent = new Agent({ provider: provider(answer([call('1', 'unknown'), call('2')]), answer()), tools: [{ ...echo, async execute() { throw new Error('broken'); } }] });
  assert.equal((await agent.run('Go')).status, 'completed');
  assert.deepEqual(agent.messages.filter(m => m.role === 'tool').map(m => m.isError), [true, true]);
});

test('cancellation closes remaining tool calls and permits next turn', async () => {
  const controller = new AbortController(); let executions = 0;
  const agent = new Agent({ provider: provider(answer([call('1'), call('2')]), answer()), tools: [{ ...echo, async execute() { executions++; controller.abort(); return 'finished'; } }] });
  assert.equal((await agent.run('Go', { signal: controller.signal })).status, 'cancelled');
  assert.equal(executions, 1);
  assert.equal(agent.messages[3].isError, true);
  assert.equal((await agent.run('Continue')).status, 'completed');
});

test('step limit retains valid tool history', async () => {
  const agent = new Agent({ provider: provider(answer([call()])), tools: [echo], maxSteps: 1 });
  assert.equal((await agent.run('Go')).status, 'limit');
  assert.equal(agent.messages.at(-1).role, 'tool');
});

test('truncated calls never execute and receive error results', async () => {
  let executed = false;
  const agent = new Agent({ provider: provider(answer([call()], 'length')), tools: [{ ...echo, async execute() { executed = true; return ''; } }] });
  assert.equal((await agent.run('Go')).status, 'error');
  assert.equal(executed, false);
  assert.equal(agent.messages.at(-1).isError, true);
});

test('provider cannot mutate history', async () => {
  const agent = new Agent({ provider: { async complete(request) { request.messages[0].content = 'changed'; return answer(); } } });
  await agent.run('Original');
  assert.equal(agent.messages[0].content, 'Original');
});

test('malformed provider response does not poison history', async () => {
  const agent = new Agent({ provider: provider(answer([{ id: 'bad', name: 'echo', arguments: 'invalid' }])) });
  assert.equal((await agent.run('Go')).status, 'error');
  assert.equal(agent.messages.length, 1);
});

test('concurrent runs and switching are rejected', async () => {
  let release;
  const agent = new Agent({ provider: { complete: () => new Promise(resolve => { release = resolve; }) } });
  const running = agent.run('Go');
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(agent.run('Other'), /already active/);
  assert.throws(() => agent.setProvider(provider()), /during a run/);
  release(answer());
  await running;
});

test('failed durable tool-start event prevents tool execution', async () => {
  let executed = false;
  const agent = new Agent({ provider: provider(answer([call()])), tools: [{ ...echo, async execute() { executed = true; return ''; } }], onEvent: async e => { if (e.type === 'tool_start') throw new Error('disk full'); } });
  assert.equal((await agent.run('Go')).status, 'error');
  assert.equal(executed, false);
  assert.equal(agent.messages.at(-1).isError, true);
});
