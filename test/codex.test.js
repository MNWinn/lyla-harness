import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodexAgent, codexLoginStatus, loginCodex } from '../src/codex.js';

async function fixture(t, mode = 'success') {
  const cwd = await mkdtemp(join(tmpdir(), 'lyla-codex-test-'));
  const bin = join(cwd, 'codex');
  await writeFile(bin, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'login') {
  process.stderr.write(${JSON.stringify(mode === 'logged-out' ? 'Not logged in' : 'Logged in using ChatGPT')});
  process.exit(${mode === 'logged-out' ? 1 : 0});
}
let input = ''; for await (const chunk of process.stdin) input += chunk;
if (!args.includes('--sandbox') || !args.includes('workspace-write') || !args.includes('--ignore-user-config')) process.exit(9);
if (${JSON.stringify(mode)} === 'hang') await new Promise(() => { setInterval(() => {}, 1000); });
console.log(JSON.stringify({type: 'item.completed', item: {type: 'agent_message', text: 'Codex fixture result'}}));
console.log(JSON.stringify({type: ${JSON.stringify(mode === 'failure' ? 'turn.failed' : 'turn.completed')}, usage: {input_tokens: 10, output_tokens: 3}}));
`, { mode: 0o700 });
  const previous = process.env.LYLA_CODEX_BIN;
  process.env.LYLA_CODEX_BIN = bin;
  t.after(async () => {
    if (previous === undefined) delete process.env.LYLA_CODEX_BIN;
    else process.env.LYLA_CODEX_BIN = previous;
    await rm(cwd, { recursive: true, force: true });
  });
  return cwd;
}

test('ChatGPT status is reused; Codex result and events reach Lyla history', async t => {
  const cwd = await fixture(t);
  assert.equal(await codexLoginStatus(), true);
  let text = '';
  await loginCodex({ output: { write: value => { text += value; } } });
  assert.match(text, /Reusing/);
  const events = [];
  const agent = new CodexAgent({ provider: { id: 'codex', model: 'default' }, cwd, onEvent: async e => events.push(e) });
  const result = await agent.run('Hello');
  assert.equal(result.status, 'completed');
  assert.equal(result.message.content, 'Codex fixture result');
  assert.ok(events.some(e => e.type === 'backend_start'));
  assert.ok(events.some(e => e.type === 'backend_event'));
  assert.equal(agent.messages.length, 2);
});

test('failed Codex turns are not reported as successful answers', async t => {
  const cwd = await fixture(t, 'failure');
  const agent = new CodexAgent({ provider: { id: 'codex', model: 'default' }, cwd });
  const result = await agent.run('Hello');
  assert.equal(result.status, 'error');
  assert.equal(agent.messages.filter(m => m.role === 'assistant').length, 0);
});

test('logged-out users receive a login instruction', async t => {
  const cwd = await fixture(t, 'logged-out');
  const result = await new CodexAgent({ provider: { id: 'codex', model: 'default' }, cwd }).run('Hello');
  assert.equal(result.status, 'error');
  assert.match(result.error, /lyla login/);
});

test('cancellation terminates the backend process', async t => {
  const cwd = await fixture(t, 'hang');
  const abort = new AbortController();
  const agent = new CodexAgent({ provider: { id: 'codex', model: 'default' }, cwd, timeoutMs: 5000, onEvent: async e => {
    if (e.type === 'backend_start') setTimeout(() => abort.abort(), 100);
  } });
  const result = await agent.run('Hello', { signal: abort.signal });
  assert.equal(result.status, 'cancelled');
});
