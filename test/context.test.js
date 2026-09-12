import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadContext } from '../src/context.js';

test('project instructions load parent first and enforce a byte budget', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'lyla-context-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const child = join(dir, 'project');
  await mkdir(child);
  await writeFile(join(dir, 'AGENTS.md'), 'Parent convention');
  await writeFile(join(child, 'AGENTS.md'), 'Child convention');
  const context = await loadContext(child);
  assert.ok(context.system.indexOf('Parent convention') < context.system.indexOf('Child convention'));
  assert.ok(context.sources.some(source => source.path === join(child, 'AGENTS.md')));
  await writeFile(join(child, 'AGENTS.md'), 'a'.repeat(65537));
  await assert.rejects(loadContext(child), /exceed/);
});
