import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/;

/** An append-only JSONL journal. One process may own a session at a time. */
export class Session {
  static async create(directory, { cwd, provider, model, system }) {
    return Session.#open(directory, randomUUID(), { cwd: resolve(cwd), provider, model, system });
  }

  static async resume(directory, id) {
    return Session.#open(directory, id);
  }

  static async #open(directory, id, metadata) {
    if (!ID.test(id)) throw new Error('Invalid session id. Use the id printed by Lyla.');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = join(directory, `${id}.jsonl`);
    const lockPath = `${file}.lock`;
    let lock;
    try { lock = await open(lockPath, 'wx', 0o600); }
    catch (error) {
      if (error.code === 'EEXIST') throw new Error(`Session is locked: ${lockPath}. If its process has exited, remove that lock before resuming.`);
      throw error;
    }
    let handle;
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      const events = metadata ? [] : await readEvents(file);
      handle = await open(file, metadata ? 'wx' : 'a', 0o600);
      const session = new Session(id, file, handle, lock, lockPath, events);
      if (metadata) await session.append({ type: 'session_start', ...metadata });
      return session;
    } catch (error) {
      await handle?.close();
      await lock.close();
      await unlink(lockPath);
      throw error;
    }
  }

  constructor(id, file, handle, lock, lockPath, events) {
    this.id = id;
    this.file = file;
    this.events = events;
    this.handle = handle;
    this.lock = lock;
    this.lockPath = lockPath;
    this.queue = Promise.resolve();
    this.closed = false;
  }

  get metadata() { return this.events[0]; }
  get messages() { return this.events.filter(e => e.type === 'message').map(e => structuredClone(e.message)); }

  append(event) {
    if (this.closed) return Promise.reject(new Error('Session is closed.'));
    const copy = structuredClone(event);
    this.queue = this.queue.then(async () => {
      const record = { ...copy, version: 1, seq: this.events.length, at: new Date().toISOString() };
      await this.handle.writeFile(`${JSON.stringify(record)}\n`);
      await this.handle.sync();
      this.events.push(record);
      return record;
    });
    return this.queue;
  }

  async feedback(verdict, note = '') {
    if (!['accepted', 'rejected', 'correction'].includes(verdict)) throw new Error('Unknown feedback verdict.');
    if (typeof note !== 'string' || note.length > 100_000) throw new Error('Feedback must be text under 100,000 characters.');
    return this.append({ type: 'feedback', verdict, note, messageSeq: this.events.findLast(e => e.type === 'message')?.seq ?? null });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try { await this.queue; }
    finally {
      await this.handle.close();
      await this.lock.close();
      await unlink(this.lockPath);
    }
  }
}

export async function readEvents(file) {
  const text = await readFile(file, 'utf8');
  if (!text.endsWith('\n')) throw new Error(`Incomplete session journal: ${file}. Preserve it for recovery; refusing to append.`);
  const events = text.trimEnd().split('\n').map((line, index) => {
    let value;
    try { value = JSON.parse(line); }
    catch { throw new Error(`Invalid JSON in session at line ${index + 1}.`); }
    if (!value || value.version !== 1 || value.seq !== index || typeof value.type !== 'string') {
      throw new Error(`Unsupported or corrupt session event at line ${index + 1}.`);
    }
    return value;
  });
  const head = events[0];
  if (head?.type !== 'session_start' || typeof head.cwd !== 'string' || typeof head.system !== 'string') {
    throw new Error('Session metadata is missing or invalid.');
  }
  return events;
}

/** Never replay an interrupted mutation. Close unmatched calls with an explicit unknown outcome. */
export async function recoverInterruptedCalls(session) {
  const pending = new Map();
  for (const message of session.messages) {
    if (message.role === 'assistant') {
      for (const call of message.toolCalls ?? []) pending.set(call.id, call);
    } else if (message.role === 'tool') pending.delete(message.toolCallId);
  }
  for (const call of pending.values()) {
    await session.append({
      type: 'message',
      message: {
        role: 'tool', toolCallId: call.id, name: call.name, isError: true,
        content: 'The prior process stopped before recording this tool result. The action may or may not have run. Inspect current state before retrying; do not assume failure or success.',
      },
    });
  }
  return pending.size;
}
