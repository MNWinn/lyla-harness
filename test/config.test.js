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
    if (chunk.toString().includes('Provider [1')) setImmediate(() => input.write('4\n'));
    callback();
  } });
  const result = await setup({ input, output, file });
  assert.equal(result.ready, true);
  assert.deepEqual(await loadConfig(file), { provider: 'demo', model: 'demo' });
  assert.match(text, /Welcome to Lyla/);
  input.destroy();
});
