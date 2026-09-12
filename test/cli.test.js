import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const env = { ...process.env, LYLA_PROVIDER: '', LYLA_MODEL: '', LYLA_BASE_URL: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', OPENAI_COMPATIBLE_API_KEY: '' };
async function directory(t) { const dir = await realpath(await mkdtemp(join(tmpdir(), 'lyla-cli-'))); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
function run(args, entry = cli) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLI timeout')); }, 10000);
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject); child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); }); child.stdin.end();
  });
}
const events = result => result.stdout.trim().split('\n').map(line => JSON.parse(line));
const completion = (content = 'Done', tool_calls) => ({ choices: [{ message: { role: 'assistant', content, ...(tool_calls ? { tool_calls } : {}) }, finish_reason: tool_calls ? 'tool_calls' : 'stop' }] });
const tool = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
async function fixture(t, handler) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    const response = handler(requests.length, requests.at(-1));
    res.writeHead(response.status ?? 200, { 'content-type': 'application/json' }); res.end(JSON.stringify(response.body ?? response));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { requests, args: ['--provider', 'openai-compatible', '--model', 'fixture', '--base-url', `http://127.0.0.1:${server.address().port}/v1`] };
}

test('CLI demo emits text or complete parseable JSON events', async t => {
  const cwd = await directory(t);
  const text = await run(['--demo', '--cwd', cwd, '-p', 'Hello']);
  assert.equal(text.code, 0); assert.match(text.stdout, /offline demo/);
  const json = await run(['--demo', '--cwd', cwd, '--json', '-p', 'Hello']);
  assert.equal(json.code, 0); const output = events(json);
  assert.equal(output[0].type, 'session'); assert.equal(output.at(-1).status, 'completed');
  assert.equal(output.find(e => e.message?.role === 'user').message.content, 'Hello');
});

test('CLI resume retains earlier conversation in provider requests', async t => {
  const cwd = await directory(t); const http = await fixture(t, () => completion());
  const first = await run([...http.args, '--cwd', cwd, '--json', '-p', 'First']);
  assert.equal(first.code, 0, first.stderr); const id = events(first)[0].id;
  const second = await run(['--cwd', cwd, '--resume', id, '--json', '-p', 'Second']);
  assert.equal(second.code, 0, second.stderr);
  assert.deepEqual(http.requests[1].messages.filter(m => m.role === 'user').map(m => m.content), ['First', 'Second']);
});

test('CLI rejects unknown flags and invalid step limits', async () => {
  for (const args of [['--unknown'], ['--max-steps', '0'], ['--provider']]) {
    const result = await run(args); assert.equal(result.code, 1); assert.match(result.stderr, /Unknown option|integer|Missing value/);
  }
});

test('CLI executes write/read tool roundtrip and persists results', async t => {
  const cwd = await directory(t);
  const http = await fixture(t, n => n === 1 ? completion('', [tool('write-1', 'write', { path: 'hello.txt', content: 'hello fixture' })]) : n === 2 ? completion('', [tool('read-1', 'read', { path: 'hello.txt' })]) : completion('Verified hello fixture'));
  const result = await run([...http.args, '--cwd', cwd, '--json', '-p', 'Write and read a greeting']);
  assert.equal(result.code, 0, result.stderr); assert.equal(await readFile(join(cwd, 'hello.txt'), 'utf8'), 'hello fixture');
  assert.equal(http.requests.length, 3);
  assert.equal(http.requests[2].messages.find(m => m.tool_call_id === 'read-1').content, 'hello fixture');
  const output = events(result); const journal = (await readFile(output[0].file, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(journal.filter(e => e.type === 'message' && e.message.role === 'tool').length, 2);
});

test('CLI exits nonzero on step limit and provider failure', async t => {
  const cwd = await directory(t);
  const http = await fixture(t, n => n === 1 ? completion('', [tool('read-1', 'read', { path: 'missing.txt' })]) : { status: 503, body: { error: 'fixture unavailable' } });
  const limited = await run([...http.args, '--cwd', cwd, '--max-steps', '1', '--json', '-p', 'Read']);
  assert.equal(limited.code, 1); assert.equal(events(limited).at(-1).status, 'limit');
  const failed = await run([...http.args, '--cwd', cwd, '--json', '-p', 'Read']);
  assert.equal(failed.code, 1); assert.equal(events(failed).at(-1).status, 'error'); assert.match(failed.stderr, /503/);
});

test('CLI works through an npm-style executable symlink', async t => {
  const cwd = await directory(t); const link = join(cwd, 'lyla'); await symlink(cli, link);
  const result = await run(['--help'], link);
  assert.equal(result.code, 0); assert.match(result.stdout, /Usage:/);
});
