import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough, Writable } from 'node:stream';
import { loadConfig, saveConfig, setup } from '../src/config.js';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'lyla-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, 'config.json');
}

test('settings persist only allowed fields with private permissions', async t => {
  const file = await fixture(t);
  assert.deepEqual(await loadConfig(file), {});
  await saveConfig({ provider: 'demo', model: 'demo', apiKey: 'do-not-store' }, file);
  assert.deepEqual(await loadConfig(file), { provider: 'demo', model: 'demo' });
  assert.ok(!(await readFile(file, 'utf8')).includes('do-not-store'));
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
  await assert.rejects(saveConfig({ provider: 'openai-compatible', model: 'local', baseUrl: 'https://user:secret@example.com' }, file), /without credentials/);
  await assert.rejects(saveConfig({ provider: 'openai', model: '' }, file), /model/);
});

test('first-run setup saves an explicitly selected offline demo', async t => {
  const file = await fixture(t);
  const input = new PassThrough();
  let text = '';
  const output = new Writable({ write(chunk, encoding, callback) {
    text += chunk;
    if (chunk.toString().includes('Select [1')) setImmediate(() => input.write('4\n'));
    callback();
  } });
  const result = await setup({ input, output, file });
  assert.equal(result.ready, true);
  assert.deepEqual(await loadConfig(file), { provider: 'demo', model: 'demo' });
  assert.match(text, /Welcome to Lyla/);
  input.destroy();
});

test('model picker persists the exact selected ID without asking for its format', async t => {
  const file = await fixture(t);
  const prompts = [];
  const output = new Writable({ write(chunk, encoding, callback) { callback(); } });
  const result = await setup({ file, output, choose: async (title, choices) => {
    prompts.push(title);
    if (title === 'Provider') return choices.find(c => c.value === 'openai').value;
    return choices.find(c => c.value === 'gpt-5.4').value;
  } });
  assert.deepEqual(prompts, ['Provider', 'Model']);
  assert.equal(result.config.model, 'gpt-5.4');
  assert.equal((await loadConfig(file)).model, 'gpt-5.4');
});

test('cancelling model selection leaves existing settings untouched', async t => {
  const file = await fixture(t);
  await saveConfig({ provider: 'demo', model: 'demo' }, file);
  const output = new Writable({ write(chunk, encoding, callback) { callback(); } });
  await assert.rejects(setup({ file, output, choose: async title => {
    if (title === 'Provider') return 'anthropic';
    throw new Error('Setup cancelled.');
  } }), /cancelled/);
  assert.equal((await loadConfig(file)).provider, 'demo');
});

test('Codex setup authenticates before saving the backend', async t => {
  const file = await fixture(t);
  let loggedIn = false;
  const output = new Writable({ write(chunk, encoding, callback) { callback(); } });
  await setup({ file, output, choose: async title => title === 'Provider' ? 'codex' : 'gpt-6-astra', login: async () => { loggedIn = true; } });
  assert.equal(loggedIn, true);
  assert.deepEqual(await loadConfig(file), { provider: 'codex', model: 'gpt-6-astra' });
});
