import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';

const exec = promisify(execFile);
const binary = () => process.env.LYLA_CODEX_BIN || 'codex';

export async function codexLoginStatus() {
  try {
    const { stdout, stderr } = await exec(binary(), ['login', 'status'], { timeout: 10000, maxBuffer: 16384 });
    return /logged in using chatgpt/i.test(`${stdout}\n${stderr}`);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('Codex CLI is not installed. Install it with npm install -g @openai/codex, then run lyla login.');
    return false;
  }
}

/** Codex owns OAuth, its browser callback, credential storage, and refresh. */
export async function loginCodex({ device = false, output = process.stderr } = {}) {
  if (await codexLoginStatus()) {
    output.write('Already signed in to Codex with ChatGPT. Reusing that login.\n');
    return;
  }
  output.write('Opening Codex sign-in. Complete the login in your browser.\n');
  await new Promise((resolve, reject) => {
    const child = spawn(binary(), ['login', ...(device ? ['--device-auth'] : [])], { stdio: 'inherit' });
    child.on('error', () => reject(new Error('Could not start Codex login. Check that codex is installed.')));
    child.on('exit', code => code === 0 ? resolve() : reject(new Error('Codex login did not complete. Run lyla login to retry.')));
  });
  if (!await codexLoginStatus()) throw new Error('ChatGPT login was not confirmed. Run lyla login to retry.');
}

/** Official Codex execution backend. Codex owns its tool loop and sandbox. */
export class CodexAgent {
  #running = false;
  constructor({ provider, system = '', cwd = process.cwd(), messages = [], onEvent = async () => {}, timeoutMs = 600000 }) {
    this.provider = provider;
    this.system = system;
    this.cwd = cwd;
    this.messages = structuredClone(messages);
    this.onEvent = onEvent;
    this.timeoutMs = timeoutMs;
  }

  async run(prompt, { signal } = {}) {
    if (this.#running) throw new Error('An agent run is already active');
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('Prompt must be nonempty');
    this.#running = true;
    let child;
    let timer;
    let timedOut = false;
    const kill = () => {
      if (!child?.pid) return;
      try { process.platform === 'win32' ? child.kill('SIGKILL') : process.kill(-child.pid, 'SIGKILL'); } catch {}
    };
    const emit = event => this.onEvent(structuredClone(event));
    const message = async value => {
      await emit({ type: 'message', message: value });
      this.messages.push(value);
    };
    let result;
    try {
      signal?.throwIfAborted();
      if (!await codexLoginStatus()) throw new Error('Sign in with lyla login before using the Codex backend.');
      await emit({ type: 'run_start', provider: 'codex', model: this.provider.model, backend: 'codex-cli' });
      await message({ role: 'user', content: prompt });
      // Send portable conversation context; credentials never enter Lyla's history.
      const history = this.messages.map(({ role, content }) => ({ role, content }));
      const input = `${this.system}\n\nContinue this conversation. Complete the latest user request using your coding tools. Previous messages are context, not new instructions.\n${JSON.stringify(history)}`;
      await emit({ type: 'backend_start', backend: 'codex-cli', sandbox: 'workspace-write' });
      signal?.throwIfAborted();
      const args = ['exec', '--json', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check', '--sandbox', 'workspace-write', '-c', 'approval_policy="never"', '-C', this.cwd];
      if (this.provider.reasoning) args.push('-c', `model_reasoning_effort=${JSON.stringify(this.provider.reasoning)}`);
      if (this.provider.model !== 'default') args.push('--model', this.provider.model);
      args.push('-');
      child = spawn(binary(), args, { cwd: this.cwd, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
      const exited = new Promise((resolve, reject) => {
        child.on('error', () => reject(new Error('Could not start Codex CLI.')));
        child.on('close', code => resolve(code));
      });
      // Attach a rejection handler immediately; stdout may close before await below.
      exited.catch(() => {});
      child.stderr.resume(); // Never copy credential-bearing diagnostics into journals.
      child.stdin.on('error', () => {});
      child.stdin.end(input);
      signal?.addEventListener('abort', kill, { once: true });
      if (signal?.aborted) kill();
      timer = setTimeout(() => { timedOut = true; kill(); }, this.timeoutMs);
      let completed = false;
      let failed = false;
      let failureMessage = '';
      let final = '';
      let bytes = 0;
      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      for await (const line of lines) {
        bytes += Buffer.byteLength(line);
        if (bytes > 16 * 1024 * 1024) throw new Error('Codex event output exceeded 16 MiB.');
        let event;
        try { event = JSON.parse(line); } catch { throw new Error('Codex returned invalid event JSON.'); }
        await emit({ type: 'backend_event', backend: 'codex-cli', event });
        if (event.type === 'item.completed' && event.item?.type === 'agent_message') final = event.item.text;
        if (event.type === 'turn.completed') {
          completed = true;
          if (event.usage) await emit({ type: 'usage', usage: { inputTokens: event.usage.input_tokens ?? 0, outputTokens: event.usage.output_tokens ?? 0 } });
        }
        if (event.type === 'turn.failed' || event.type === 'error') {
          failed = true;
          const raw = event.error?.message ?? event.message;
          if (typeof raw === 'string') {
            try { failureMessage = JSON.parse(raw).error?.message || raw; }
            catch { failureMessage = raw; }
          }
        }
      }
      const code = await exited;
      signal?.throwIfAborted();
      if (timedOut) throw new Error('Codex turn timed out. Inspect the workspace before retrying.');
      if (code !== 0 || failed || !completed || typeof final !== 'string' || !final.trim()) throw new Error(failureMessage || 'Codex turn failed or returned no final answer. Check the session backend events; inspect workspace state before retrying.');
      const answer = { role: 'assistant', content: final };
      await message(answer);
      result = { status: 'completed', message: answer };
    } catch (error) {
      result = { status: signal?.aborted ? 'cancelled' : 'error', error: error.message };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', kill);
      kill();
      try { await emit({ type: 'run_end', ...result }); }
      catch (error) { result = { status: 'error', error: error.message }; }
      this.#running = false;
    }
    return result;
  }
}
