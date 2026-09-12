import { open, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

const MAX_FILE = 8 * 1024 * 1024;
const MAX_OUTPUT = 32 * 1024;
const MARKER = '\n[output truncated]';
function aborted(signal) { signal?.throwIfAborted(); }
function object(args) { if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Arguments must be an object'); }
function string(args, key, nonempty = false) {
  if (typeof args[key] !== 'string' || (nonempty && !args[key].length)) throw new Error(`${key} must be ${nonempty ? 'a nonempty' : 'a'} string`);
  return args[key];
}
function integer(args, key, fallback, max) {
  const value = args[key] ?? fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`${key} must be an integer between 1 and ${max}`);
  return value;
}
function bounded(text) {
  const bytes = Buffer.from(text);
  if (bytes.length <= MAX_OUTPUT) return text;
  // Decode only complete UTF-8 characters, reserving room for the marker.
  let end = MAX_OUTPUT - Buffer.byteLength(MARKER);
  while ((bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8') + MARKER;
}
async function readText(path, signal) {
  aborted(signal);
  const file = await open(path, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error('Path must be a regular file');
    if (info.size > MAX_FILE) throw new Error('File exceeds 8 MiB limit');
    const buffer = Buffer.alloc(MAX_FILE + 1);
    let size = 0;
    while (size < buffer.length) {
      aborted(signal);
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_FILE) throw new Error('File exceeds 8 MiB limit');
    const data = buffer.subarray(0, size);
    if (data.includes(0)) throw new Error('Binary files are not supported');
    try { return new TextDecoder('utf-8', { fatal: true }).decode(data); }
    catch { throw new Error('File is not valid UTF-8 text'); }
  } finally { await file.close(); }
}
const schema = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
const text = { type: 'string' };

// Trusted local execution with the user's permissions. cwd is a working directory,
// not a sandbox: absolute paths, parent paths, and arbitrary shell commands work.
export function createTools() {
  return [
    { name: 'read', description: 'Read a UTF-8 file, optionally by 1-based line offset and line limit. Output is capped at 32 KiB; files at 8 MiB.',
      parameters: schema({ path: text, offset: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 10000 } }, ['path']),
      async execute(args, { cwd, signal }) {
        object(args);
        const path = resolve(cwd, string(args, 'path', true));
        const offset = integer(args, 'offset', 1, Number.MAX_SAFE_INTEGER);
        const limit = integer(args, 'limit', 200, 10000);
        const content = await readText(path, signal);
        const lines = content.split('\n');
        const selected = lines.slice(offset - 1, offset - 1 + limit);
        const suffix = offset - 1 + limit < lines.length ? `\n[more lines available; next offset ${offset + limit}]` : '';
        return bounded(selected.join('\n') + suffix);
      } },
    { name: 'write', description: 'Write a UTF-8 file, replacing its contents. Parent directory must exist. Maximum content size is 8 MiB.',
      parameters: schema({ path: text, content: text }, ['path', 'content']),
      async execute(args, { cwd, signal }) {
        object(args);
        const path = resolve(cwd, string(args, 'path', true));
        const content = string(args, 'content');
        if (Buffer.byteLength(content) > MAX_FILE) throw new Error('Content exceeds 8 MiB limit');
        aborted(signal);
        await writeFile(path, content, { encoding: 'utf8', signal });
        return `Wrote ${Buffer.byteLength(content)} bytes to ${path}`;
      } },
    { name: 'edit', description: 'Replace exactly one occurrence of nonempty oldText in a UTF-8 file. Errors if absent or ambiguous.',
      parameters: schema({ path: text, oldText: text, newText: text }, ['path', 'oldText', 'newText']),
      async execute(args, { cwd, signal }) {
        object(args);
        const path = resolve(cwd, string(args, 'path', true));
        const oldText = string(args, 'oldText', true), newText = string(args, 'newText');
        const content = await readText(path, signal);
        const start = content.indexOf(oldText);
        if (start < 0) throw new Error('oldText was not found');
        if (content.indexOf(oldText, start + 1) >= 0) throw new Error('oldText matches more than once');
        const updated = content.slice(0, start) + newText + content.slice(start + oldText.length);
        if (Buffer.byteLength(updated) > MAX_FILE) throw new Error('Edited content exceeds 8 MiB limit');
        aborted(signal);
        await writeFile(path, updated, { encoding: 'utf8', signal });
        return `Edited ${path}`;
      } },
    { name: 'bash', description: 'Run a bash command with full local permissions. Combined output capped at 32 KiB. Default timeout 30s, maximum 120s. Nonzero exit is an error.',
      parameters: schema({ command: text, timeoutMs: { type: 'integer', minimum: 1, maximum: 120000 } }, ['command']),
      async execute(args, { cwd, signal }) {
        object(args);
        const command = string(args, 'command', true);
        const timeoutMs = integer(args, 'timeoutMs', 30000, 120000);
        aborted(signal);
        return new Promise((accept, reject) => {
          const child = spawn('bash', ['-c', command], { cwd, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
          let captured = Buffer.alloc(0), truncated = false, reason, settled = false;
          function kill() {
            try { process.platform === 'win32' ? child.kill('SIGKILL') : process.kill(-child.pid, 'SIGKILL'); } catch {}
          }
          function finish(error, code) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            kill(); // Also clean up background children after the shell exits.
            const output = bounded(captured.toString('utf8') + (truncated ? MARKER : ''));
            if (error || reason || code !== 0) reject(new Error(`${reason || error?.message || `Command exited with code ${code}`}\n${output}`));
            else accept(output);
          }
          function capture(chunk) {
            const remaining = MAX_OUTPUT - captured.length;
            if (chunk.length > remaining) truncated = true;
            if (remaining > 0) captured = Buffer.concat([captured, chunk.subarray(0, remaining)]);
          }
          function onAbort() { reason = 'Command aborted'; kill(); }
          const timer = setTimeout(() => { reason = 'Command timed out'; kill(); }, timeoutMs);
          signal?.addEventListener('abort', onAbort, { once: true });
          if (signal?.aborted) onAbort();
          child.stdout.on('data', capture);
          child.stderr.on('data', capture);
          child.on('error', error => finish(error));
          child.on('exit', () => kill());
          child.on('close', code => finish(null, code));
        });
      } },
  ];
}
