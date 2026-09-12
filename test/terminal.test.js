import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { TerminalChat } from '../src/terminal.js';
import { reasoningLevels } from '../src/reasoning.js';
function fixture(t) {
  const input = new PassThrough(); input.setRawMode = value => { input.isRaw = value; };
  const output = new PassThrough(); output.columns = 25;
  let rendered = ''; output.on('data', b => { rendered += b; });
  let cycles = 0, interrupts = 0, busy = false;
  const ui = new TerminalChat({ input, output, status: () => ({ model: 'gpt-6-astra', reasoning: 'high', busy }), onCycle: () => cycles++, onInterrupt: () => interrupts++ });
  t.after(() => ui.close());
  return { ui, input, output, rendered: () => rendered, cycles: () => cycles, interrupts: () => interrupts, busy: value => { busy = value; } };
}
test('composer cycles thinking, edits, submits and restores raw mode', async t => {
  const f = fixture(t); const result = f.ui.read();
  f.input.write('helo\x1b[D' + 'l\x1b[Z\r');
  assert.equal(await result, 'hello'); assert.equal(f.cycles(), 1);
  assert.match(f.rendered(), /Lyla · high/);
  f.ui.close(); assert.equal(f.input.isRaw, false); assert.equal(f.input.listenerCount('keypress'), 0);
});
test('bracketed paste does not submit embedded newlines; busy escape cancels', async t => {
  const f = fixture(t); const result = f.ui.read();
  f.input.write('\x1b[200~first\nsecond\x1b[201~');
  assert.equal(f.ui.text, 'first\nsecond');
  f.input.write('\r'); assert.equal(await result, 'first\nsecond');
  f.busy(true); f.ui.handle(undefined, { name: 'escape' }); assert.equal(f.interrupts(), 1);
});
test('Alt+Enter adds a newline and empty Ctrl+C exits', async t => {
  const f = fixture(t); const result = f.ui.read();
  f.ui.handle('\r', { name: 'return', meta: true });
  assert.equal(f.ui.text, '\n');
  f.ui.handle(undefined, { name: 'c', ctrl: true });
  f.ui.handle(undefined, { name: 'c', ctrl: true });
  assert.equal(await result, null);
});
test('reasoning choices are restricted to known supporting models', () => {
  assert.deepEqual(reasoningLevels('codex', 'gpt-6-astra'), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(reasoningLevels('anthropic', 'any'), []);
});

test('working spinner animates and stops after completion or suspension', async t => {
  const f = fixture(t);
  f.busy(true); f.ui.render();
  assert.match(f.rendered(), /⠋ Working…/);
  await new Promise(resolve => setTimeout(resolve, 130));
  assert.match(f.rendered(), /⠙ Working…/);
  f.busy(false); f.ui.render(); assert.equal(f.ui.spinner, undefined);
  f.busy(true); f.ui.render(); f.ui.pause(); assert.equal(f.ui.spinner, undefined);
});
