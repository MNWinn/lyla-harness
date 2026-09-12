import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { select } from '../src/select.js';
import { modelChoices } from '../src/models.js';

function terminal() {
  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = value => { input.isRaw = value; };
  let text = '';
  const output = new Writable({ write(chunk, encoding, callback) { text += chunk; callback(); } });
  output.isTTY = true;
  output.columns = 40;
  return { input, output, text: () => text };
}
const choices = [{ label: 'First', value: 'first-id' }, { label: 'Second', value: 'second-id' }];

test('arrow selection returns exact ID and restores terminal state', async () => {
  const io = terminal();
  const promise = select('Model', choices, io);
  io.input.emit('keypress', '', { name: 'down' });
  io.input.emit('keypress', '', { name: 'return' });
  assert.equal(await promise, 'second-id');
  assert.equal(io.input.isRaw, false);
  assert.equal(io.input.isPaused(), true);
  assert.equal(io.input.listenerCount('keypress'), 0);
  assert.match(io.text(), /❯ Second/);
  io.input.destroy();
});

test('escape cancels and restores terminal input', async () => {
  const io = terminal();
  const promise = select('Model', choices, io);
  io.input.emit('keypress', '', { name: 'escape' });
  await assert.rejects(promise, /cancelled/);
  assert.equal(io.input.isRaw, false);
  io.input.destroy();
});

test('compatible models use server IDs and handle failed discovery', async () => {
  const result = await modelChoices('openai-compatible', 'http://localhost/v1', { fetchImpl: async url => {
    assert.equal(url, 'http://localhost/v1/models');
    return { ok: true, json: async () => ({ data: [{ id: 'local:model' }, { id: 'local:model' }, { id: '\x1b[2J' }] }) };
  } });
  assert.deepEqual(result.choices, [{ label: 'local:model', value: 'local:model' }]);
  const fallback = await modelChoices('openai-compatible', 'http://localhost/v1', { fetchImpl: async () => { throw new Error('Offline'); } });
  assert.deepEqual(fallback.choices, []);
});
