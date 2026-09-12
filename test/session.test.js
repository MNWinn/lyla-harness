import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, appendFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Session, readEvents, recoverInterruptedCalls } from '../src/session.js';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'lyla-session-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const metadata = { cwd: process.cwd(), provider: 'demo', model: 'demo', system: 'test' };

test('session persists ordered events and explicit feedback across resume', async t => {
  const dir = await fixture(t);
  const s = await Session.create(dir, metadata);
  await Promise.all([
    s.append({ type: 'message', message: { role: 'user', content: 'Fix it' } }),
    s.append({ type: 'message', message: { role: 'assistant', content: 'Done' } }),
  ]);
  await s.feedback('accepted', 'Reviewed diff and tests');
  await s.close();
  const resumed = await Session.resume(dir, s.id);
  assert.equal(resumed.messages.length, 2);
  assert.equal(resumed.events[3].verdict, 'accepted');
  assert.equal(resumed.events[3].messageSeq, 2);
  assert.deepEqual(resumed.events.map(e => e.seq), [0, 1, 2, 3]);
  const copied = resumed.messages;
  copied[0].content = 'mutated';
  assert.equal(resumed.messages[0].content, 'Fix it');
  if (process.platform !== 'win32') assert.equal((await stat(s.file)).mode & 0o777, 0o600);
  await resumed.close();
});

test('locks prevent concurrent owners and invalid ids cannot escape session directory', async t => {
  const dir = await fixture(t);
  const s = await Session.create(dir, metadata);
  await assert.rejects(Session.resume(dir, s.id), /locked/);
  await assert.rejects(Session.resume(dir, '../escape'), /Invalid session id/);
  await s.close();
});

test('partial journals fail closed without appending or leaving a lock', async t => {
  const dir = await fixture(t);
  const s = await Session.create(dir, metadata);
  await s.close();
  await appendFile(s.file, '{"partial":');
  await assert.rejects(Session.resume(dir, s.id), /Incomplete/);
  await assert.rejects(stat(`${s.file}.lock`), { code: 'ENOENT' });
});

test('recovery closes pending calls without executing them and remains idempotent', async t => {
  const s = await Session.create(await fixture(t), metadata);
  await s.append({ type: 'message', message: { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'write', arguments: { path: 'x', content: 'x' } }] } });
  assert.equal(await recoverInterruptedCalls(s), 1);
  assert.equal(await recoverInterruptedCalls(s), 0);
  assert.equal(s.messages[1].isError, true);
  assert.match(s.messages[1].content, /may or may not/);
  await s.close();
  assert.equal((await readEvents(s.file)).length, 3);
});
