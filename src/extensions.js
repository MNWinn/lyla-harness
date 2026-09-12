import { mkdir, readFile, writeFile, rename, rm, realpath, stat, lstat, readdir, readlink, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { configPath } from './config.js';

const exec = promisify(execFile);
export const EXTENSION_CONTRACT_VERSION = 1;
const rootDefault = () => join(dirname(configPath()), 'extensions');
function checkHandler(handler) { if (typeof handler !== 'function') throw new Error('Extension hook must be a function'); }
const clone = value => freeze(structuredClone(value));
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
async function json(file, fallback) { try { return JSON.parse(await readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; } }
async function atomic(file, value) { await mkdir(dirname(file), { recursive: true, mode: 0o700 }); const tmp = `${file}.${randomUUID()}`; await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); await rename(tmp, file); }
const MAX_FILES = 20000, MAX_BYTES = 128 * 1024 * 1024;
const inside = (base, file) => { const path = relative(base, file); return path === '' || (!path.startsWith('..') && !isAbsolute(path)); };
async function withRegistryLock(root, operation) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const lock = join(root, 'registry.lock');
  let handle;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { handle = await open(lock, 'wx', 0o600); break; }
    catch (error) { if (error.code !== 'EEXIST') throw error; await new Promise(resolve => setTimeout(resolve, 25)); }
  }
  if (!handle) throw new Error(`Extension registry is locked: ${lock}. Retry; remove a stale lock only after confirming no installer is running.`);
  try { await handle.writeFile(String(process.pid)); return await operation(); }
  finally { await handle.close(); await rm(lock, { force: true }); }
}
async function walkPackage(base, { local = false, copyTo } = {}) {
  base = await realpath(base);
  const hash = createHash('sha256'); let count = 0, bytes = 0;
  const pkg = local ? await json(join(base, 'package.json')) : undefined;
  const files = pkg?.files;
  if (files && (!Array.isArray(files) || files.some(p => typeof p !== 'string' || p.includes('..') || isAbsolute(p) || /[*?![\\]/.test(p)))) throw new Error('Local package files must use literal relative file/directory paths (no globs)');
  const allowed = rel => !files || rel === 'package.json' || /^(README|LICENSE|LICENCE)(\.|$)/i.test(rel) || files.some(p => { p = p.replace(/^\.\//, '').replace(/\/$/, ''); return rel === p || rel.startsWith(p + '/') || p.startsWith(rel + '/'); });
  async function visit(dir, rel = '') {
    for (const name of (await readdir(dir)).sort()) {
      const path = join(dir, name), key = rel ? `${rel}/${name}` : name;
      if (local && (['.git', 'node_modules', '.lyla', '.DS_Store', 'secrets', '.secrets'].includes(name) || /^\.env(?:\.|$)/.test(name) || /\.(tgz|pem|key)$/i.test(name) || !allowed(key))) continue;
      const info = await lstat(path);
      if (++count > MAX_FILES) throw new Error('Extension package exceeds file limit');
      if (info.isSymbolicLink()) {
        if (local) throw new Error(`Local package symlinks are not supported: ${key}`);
        if (!inside(base, await realpath(path))) throw new Error(`Package symlink escapes installation: ${key}`);
        hash.update(JSON.stringify(['link', key, await readlink(path)])); continue;
      }
      if (!inside(base, await realpath(path))) throw new Error('Package path escapes source');
      if (info.isDirectory()) { if (copyTo) await mkdir(join(copyTo, key), { recursive: true, mode: 0o700 }); await visit(path, key); }
      else if (info.isFile()) {
        bytes += info.size; if (bytes > MAX_BYTES) throw new Error('Extension package exceeds 128 MiB limit');
        const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        let data; try { data = await handle.readFile(); } finally { await handle.close(); }
        if (data.length !== info.size) throw new Error('Package changed during installation');
        hash.update(JSON.stringify(['file', key, info.mode & 0o111, data.length])); hash.update(data);
        if (copyTo) await writeFile(join(copyTo, key), data, { mode: info.mode & 0o777 });
      } else throw new Error(`Unsupported package file: ${key}`);
    }
  }
  await visit(base); return { algorithm: 'sha256', digest: hash.digest('hex'), files: count, bytes };
}
export async function runtimeIdentity() {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  return { harnessVersion: pkg.version, toolFingerprint: createHash('sha256').update(await readFile(new URL('./tools.js', import.meta.url))).digest('hex') };
}
export async function extensionManifest(directory) {
  const pkg = await json(join(directory, 'package.json'));
  const manifest = pkg?.lylaExtension;
  if (!pkg?.name || !pkg?.version || !manifest || !/^[a-z][a-z0-9-]*$/.test(manifest.id) || manifest.contractVersion !== 1) throw new Error('Invalid package or unsupported Lyla extension contract (requires version 1)');
  if (typeof manifest.entry !== 'string' || !manifest.entry.startsWith('./')) throw new Error('Extension entry must be a relative ./ path');
  const base = await realpath(directory), entry = await realpath(resolve(base, manifest.entry));
  const rel = relative(base, entry);
  if (rel.startsWith('..') || isAbsolute(rel) || !(await stat(entry)).isFile()) throw new Error('Extension entry escapes package');
  return { ...manifest, name: pkg.name, version: pkg.version };
}
export async function listExtensions(root = rootDefault()) { return await json(join(root, 'registry.json'), []); }
export async function installExtension(source, { root = rootDefault(), updateId } = {}) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const staged = join(root, 'packages', randomUUID());
  await mkdir(staged, { recursive: true, mode: 0o700 });
  let directory = staged;
  try {
    if (source.startsWith('npm:')) {
      const spec = source.slice(4);
      if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+(?:@[a-zA-Z0-9.*^~+-]+)?$/.test(spec)) throw new Error('Expected npm:package-name[@version]');
      await writeFile(join(staged, 'package.json'), '{"private":true}');
      await exec('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', '--prefix', staged, spec], { timeout: 120000, maxBuffer: 1024 * 1024 });
      const pkg = await json(join(staged, 'package.json'));
      const names = Object.keys(pkg.dependencies || {});
      if (names.length !== 1) throw new Error('Expected one extension package');
      directory = join(staged, 'node_modules', names[0]);
    } else {
      source = await realpath(resolve(source.replace(/^local:/, '')));
      await extensionManifest(source);
      if (inside(source, await realpath(staged))) throw new Error('Extension installation directory cannot be inside its source');
      await walkPackage(source, { local: true, copyTo: staged });
    }
    const manifest = await extensionManifest(directory);
    const integrity = await walkPackage(staged);
    return await withRegistryLock(root, async () => {
    const entries = await listExtensions(root), previous = entries.find(e => e.id === manifest.id);
    if (updateId && !previous) throw new Error('Extension was removed during update');
    if (updateId && updateId !== manifest.id) throw new Error('Update cannot change extension identity');
    if (previous && !updateId) throw new Error(`Extension ${manifest.id} already installed; use extensions update`);
    const record = { ...manifest, integrity, directory, packageRoot: staged, source, enabled: previous?.enabled ?? true, installedAt: new Date().toISOString() };
    await atomic(join(root, 'registry.json'), [...entries.filter(e => e.id !== record.id), record]);
    // Old snapshots remain until explicit removal, so running processes retain valid imports.
    return record;
    });
  } catch (error) { await rm(staged, { recursive: true, force: true }); throw error; }
}
export async function manageExtension(action, id, { root = rootDefault(), version } = {}) {
  const entries = await listExtensions(root), entry = entries.find(e => e.id === id);
  if (!entry) throw new Error(`Extension ${id} is not installed`);
  if (action === 'update') {
    let source = entry.source;
    if (version) { if (!source.startsWith('npm:')) throw new Error('--version applies only to npm sources'); source = `npm:${entry.name}@${version}`; }
    return installExtension(source, { root, updateId: id });
  }
  return withRegistryLock(root, async () => {
  const entries = await listExtensions(root), entry = entries.find(e => e.id === id);
  if (!entry) throw new Error(`Extension ${id} is not installed`);
  if (!['enable', 'disable', 'remove'].includes(action)) throw new Error('Expected enable, disable, update, or remove');
  if (action !== 'remove') entry.enabled = action === 'enable';
  await atomic(join(root, 'registry.json'), action === 'remove' ? entries.filter(e => e.id !== id) : entries);
  return entry;
  });
}

/** Installed extensions are trusted local code. Journals and contributions remain untrusted data. */
export class ExtensionHost {
  constructor({ root = rootDefault(), getContext = () => ({}), append = async () => {}, runtime = {}, report = text => process.stdout.write(`${text}\n`), contextBudgetBytes = 8192 } = {}) {
    if (!Number.isSafeInteger(contextBudgetBytes) || contextBudgetBytes < 0) throw new Error('Invalid extension context byte budget');
    Object.assign(this, { root, contextSource: getContext, appendEvent: append, runtime, report, contextBudgetBytes });
    this.commands = new Map(); this.starts = []; this.events = []; this.contexts = []; this.disposers = [];
  }
  getContext(extra = {}) { const context = { ...this.identity, ...this.contextSource(), ...extra }; context.capabilities = context.provider?.id === 'codex' ? { injectionScope: 'backend-turn', internalToolTelemetry: false } : { injectionScope: 'model-request', internalToolTelemetry: true }; return clone(context); }
  async load() {
    try {
    this.identity = await runtimeIdentity();
    for (const entry of await listExtensions(this.root)) {
      if (!entry.enabled) continue;
      const integrity = await walkPackage(entry.packageRoot);
      if (!entry.integrity || integrity.digest !== entry.integrity.digest) throw new Error(`Extension ${entry.id} integrity mismatch; reinstall the package`);
      const manifest = await extensionManifest(entry.directory);
      if (manifest.id !== entry.id || manifest.version !== entry.version) throw new Error('Installed extension manifest changed');
      const storageDir = join(this.root, 'storage', entry.id);
      await mkdir(storageDir, { recursive: true, mode: 0o700 });
      const api = Object.freeze({
        storageDir, runtime: Object.freeze({ ...this.runtime }), report: this.report,
        getContext: () => this.getContext(),
        append: event => this.appendEvent({ ...structuredClone(event), extensionId: entry.id }),
        registerCommand: (name, handler) => { if (!/^[a-z][a-z0-9-]*$/.test(name) || this.commands.has(name) || ['help','exit','quit','new','session','feedback','model','login','setup','install','extensions'].includes(name) || typeof handler !== 'function') throw new Error(`Invalid or duplicate extension command: ${name}`); this.commands.set(name, handler); },
        onRunStart: handler => { checkHandler(handler); this.starts.push(handler); }, onEvent: handler => { checkHandler(handler); this.events.push(handler); },
        contributeContext: handler => { checkHandler(handler); this.contexts.push({ id: entry.id, handler }); },
      });
      const module = await import(pathToFileURL(resolve(entry.directory, manifest.entry)).href);
      const activate = module.activate ?? module.default;
      if (typeof activate !== 'function') throw new Error(`Extension ${entry.id} must export activate(host)`);
      const dispose = await activate(api);
      if (typeof dispose === 'function') this.disposers.push(dispose);
      else if (typeof dispose?.dispose === 'function') this.disposers.push(() => dispose.dispose());
    }
    return this;
    } catch (error) { await this.dispose(); throw error; }
  }
  async dispatch(name, args = [], { signal } = {}) { const handler = this.commands.get(name); if (!handler) throw new Error(`Unknown extension command: ${name}`); return handler(clone(args), Object.freeze({ ...this.getContext(), signal })); }
  async beforeRun(extra) { for (const handler of this.starts) await handler(this.getContext(extra)); }
  async onEvent(event) { for (const handler of this.events) await handler(clone(event), this.getContext()); }
  async beforeRequest(extra) {
    let bytes = 0; const accepted = [], omitted = [];
    for (const { id, handler } of this.contexts) {
      const contributions = await handler(this.getContext(extra));
      if (contributions == null) continue;
      if (!Array.isArray(contributions)) throw new Error('Extension context must be an array');
      for (const contribution of contributions) {
        if (typeof contribution?.text !== 'string' || !contribution.id || !contribution.version) throw new Error('Context contribution requires id, version, and text');
        const item = { ...structuredClone(contribution), extensionId: id };
        const size = Buffer.byteLength(item.text) + (accepted.length ? 2 : 0);
        if (bytes + size > this.contextBudgetBytes) { omitted.push({ id: item.id, version: item.version, extensionId: id, reason: 'context-budget' }); continue; }
        accepted.push(item); bytes += size;
      }
    }
    await this.appendEvent({ type: 'context_injection', injectionScope: extra?.injectionScope ?? 'model-request', requestIndex: extra?.requestIndex, entries: accepted, omitted, bytes });
    return accepted.map(e => e.text).join('\n\n');
  }
  async dispose() { for (const dispose of this.disposers.reverse()) await dispose(); this.commands.clear(); this.starts = []; this.events = []; this.contexts = []; this.disposers = []; }
}
