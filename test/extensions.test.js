import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExtensionHost, installExtension, manageExtension, listExtensions } from '../src/extensions.js';
import { Agent } from '../src/agent.js';

async function fixture(code) {
  const dir = await mkdtemp(join(tmpdir(), 'lyla-extension-')), root = join(dir, 'registry'), source = join(dir, 'source');
  await mkdir(source);
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', type: 'module', scripts: { install: 'exit 1' }, lylaExtension: { id: 'fixture', contractVersion: 1, entry: './index.js' } }));
  await writeFile(join(source, 'index.js'), code);
  return { root, source };
}
test('local installation snapshots code, lifecycle preserves storage, scripts never run', async () => {
  const { root, source } = await fixture('export function activate() {}');
  const record = await installExtension(source, { root });
  await writeFile(join(source, 'index.js'), 'invalid source');
  assert.equal(await readFile(join(record.directory, 'index.js'), 'utf8'), 'export function activate() {}');
  await manageExtension('disable', 'fixture', { root }); assert.equal((await listExtensions(root))[0].enabled, false);
  await manageExtension('enable', 'fixture', { root });
  const host = await new ExtensionHost({ root }).load();
  const storage = join(root, 'storage', 'fixture', 'evidence'); await writeFile(storage, 'kept');
  await host.dispose(); await manageExtension('remove', 'fixture', { root });
  assert.equal(await readFile(storage, 'utf8'), 'kept'); assert.deepEqual(await listExtensions(root), []);
});
test('host freezes contexts, bounds contributions, journals attribution before inference without history duplication', async () => {
  const { root, source } = await fixture(`export function activate(host) {
    host.registerCommand('fixture', (args, ctx) => { if (!Object.isFrozen(ctx) || !Object.isFrozen(args)) throw Error('mutable'); return ctx.cwd; });
    host.contributeContext(() => [{id:'lesson',version:1,text:'use tests'}, {id:'large',version:1,text:'x'.repeat(100)}]);
  }`);
  await installExtension(source, { root });
  const events = [], systems = [];
  const host = await new ExtensionHost({ root, getContext: () => ({ cwd: '/work' }), append: async e => events.push(e), contextBudgetBytes: 20 }).load();
  assert.equal(await host.dispatch('fixture'), '/work');
  const agent = new Agent({ provider: { id:'fixture', model:'fixture', complete: async request => { assert.equal(events.at(-1).type, 'context_injection'); systems.push(request.system); return {message:{role:'assistant',content:'done'},finishReason:'stop'}; } }, system:'base', beforeRun: x => host.beforeRun(x), beforeRequest: x => host.beforeRequest(x) });
  assert.equal((await agent.run('task')).status, 'completed'); assert.equal((await agent.run('again')).status, 'completed');
  assert.deepEqual(systems, ['base\n\nuse tests','base\n\nuse tests']); assert.equal(agent.messages.some(m => m.content.includes('use tests')), false);
  assert.equal(events[0].omitted[0].reason, 'context-budget'); await host.dispose();
});
test('hook and durable attribution failures prevent inference', async () => {
  let calls = 0;
  const agent = new Agent({ provider: { complete: async () => { calls++; } }, beforeRequest: async () => { throw Error('journal unavailable'); } });
  assert.equal((await agent.run('task')).status, 'error'); assert.equal(calls, 0);
  const early = new Agent({ provider: { complete: async () => { calls++; } }, beforeRun: async () => { throw Error('capture failed'); } });
  assert.equal((await early.run('task')).status, 'error'); assert.equal(calls, 0);
});
test('unsupported contracts fail before activation', async () => {
  const { root, source } = await fixture('throw Error("must not execute")');
  await writeFile(join(source,'package.json'), JSON.stringify({ name:'fixture',version:'1',lylaExtension:{id:'fixture',contractVersion:2,entry:'./index.js'} }));
  await assert.rejects(installExtension(source,{root}), /unsupported/);
});
test('CLI extension command runs offline with cwd and no configured provider', async () => {
  const { execFile } = await import('node:child_process'); const { promisify } = await import('node:util');
  const { root, source } = await fixture(`export function activate(host) { host.registerCommand('fixture', (args,ctx) => host.report(JSON.stringify({args,cwd:ctx.cwd,provider:ctx.provider}))); }`);
  await installExtension(source, { root });
  // The normal registry is <config>/extensions.
  const { symlink } = await import('node:fs/promises');
  const config = join(root, '..', 'config'); await mkdir(config); await symlink(root, join(config,'extensions'));
  const { stdout } = await promisify(execFile)(process.execPath, ['src/cli.js','fixture','hello','--cwd',source], { cwd:process.cwd(),env:{...process.env,LYLA_CONFIG_DIR:config} });
  assert.deepEqual(JSON.parse(stdout), {args:['hello'],cwd:await realpath(source)});
});
