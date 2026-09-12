import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTools } from '../src/tools.js';
const tools = Object.fromEntries(createTools().map(tool => [tool.name, tool]));
async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'lyla-tools-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return { cwd };
}
test('write, read by lines, and exact edit', async t => {
  const ctx = await fixture(t);
  await tools.write.execute({ path: 'a', content: 'first\nsecond\nthird' }, ctx);
  assert.match(await tools.read.execute({ path: 'a', offset: 2, limit: 1 }, ctx), /^second\n\[more lines/);
  await tools.edit.execute({ path: 'a', oldText: 'second', newText: 'updated' }, ctx);
  assert.equal(await readFile(join(ctx.cwd, 'a'), 'utf8'), 'first\nupdated\nthird');
  await assert.rejects(tools.edit.execute({ path: 'a', oldText: '', newText: '' }, ctx), /nonempty/);
  await assert.rejects(tools.edit.execute({ path: 'a', oldText: 'absent', newText: '' }, ctx), /not found/);
  await writeFile(join(ctx.cwd, 'a'), 'aaa');
  await assert.rejects(tools.edit.execute({ path: 'a', oldText: 'aa', newText: '' }, ctx), /more than once/);
});
test('limits, binary rejection and argument validation', async t => {
  const ctx = await fixture(t);
  await writeFile(join(ctx.cwd, 'a'), '🙂'.repeat(20000));
  const result = await tools.read.execute({ path: 'a' }, ctx);
  assert.ok(Buffer.byteLength(result) <= 32768);
  assert.ok(!result.includes('\ufffd'));
  assert.match(result, /truncated/);
  await writeFile(join(ctx.cwd, 'a'), Buffer.from([0, 1, 2]));
  await assert.rejects(tools.read.execute({ path: 'a' }, ctx), /Binary/);
  await assert.rejects(tools.edit.execute({ path: 'a', oldText: 'x', newText: '' }, ctx), /Binary/);
  await assert.rejects(tools.read.execute({ path: 'a', offset: 0 }, ctx), /integer/);
  await assert.rejects(tools.write.execute({ path: 'a', content: 42 }, ctx), /string/);
});
test('already aborted signals prevent mutations and shell execution', async t => {
  const ctx = { ...await fixture(t), signal: AbortSignal.abort() };
  await assert.rejects(tools.write.execute({ path: 'a', content: 'x' }, ctx));
  await assert.rejects(readFile(join(ctx.cwd, 'a')), /ENOENT/);
  await assert.rejects(tools.bash.execute({ command: 'touch a' }, ctx));
  await assert.rejects(readFile(join(ctx.cwd, 'a')), /ENOENT/);
});
test('bash captures output, rejects nonzero, truncates, times out and aborts', async t => {
  const ctx = await fixture(t);
  assert.equal(await tools.bash.execute({ command: 'printf hello' }, ctx), 'hello');
  await assert.rejects(tools.bash.execute({ command: 'printf failure >&2; exit 3' }, ctx), /code 3\nfailure/);
  const output = await tools.bash.execute({ command: "yes x | head -c 100000" }, ctx);
  assert.ok(Buffer.byteLength(output) <= 32768);
  assert.match(output, /truncated/);
  await assert.rejects(tools.bash.execute({ command: 'sleep 10', timeoutMs: 30 }, ctx), /timed out/);
  const controller = new AbortController();
  const pending = tools.bash.execute({ command: 'sleep 10' }, { ...ctx, signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(pending, /aborted/);
  assert.equal(await tools.bash.execute({ command: 'sleep 10 & printf done', timeoutMs: 500 }, ctx), 'done');
});
