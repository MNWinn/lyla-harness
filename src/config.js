import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';

export function configPath() {
  return join(process.env.LYLA_CONFIG_DIR || join(homedir(), '.config', 'lyla'), 'config.json');
}

export function validateConfig(value) {
  if (!value || !['openai', 'anthropic', 'openai-compatible', 'demo'].includes(value.provider)) throw new Error('Configuration needs a supported provider.');
  if (typeof value.model !== 'string' || !value.model.trim()) throw new Error('Configuration needs a model ID.');
  if (value.baseUrl !== undefined) {
    let url;
    try { url = new URL(value.baseUrl); } catch { throw new Error('Configuration has an invalid base URL.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Base URL must be HTTP(S), without credentials, query, or fragment.');
  }
  if (value.provider === 'openai-compatible' && !value.baseUrl) throw new Error('An OpenAI-compatible provider needs a base URL.');
  return { provider: value.provider, model: value.model.trim(), ...(value.baseUrl ? { baseUrl: value.baseUrl } : {}) };
}

export async function loadConfig(file = configPath()) {
  try { return validateConfig(JSON.parse(await readFile(file, 'utf8'))); }
  catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error(`Cannot read ${file}: ${error.message}. Run lyla setup to replace it.`);
  }
}

export async function saveConfig(value, file = configPath()) {
  const config = validateConfig(value);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await rename(temporary, file);
  return config;
}

/** Ask only for non-secret settings. Credentials stay in environment variables. */
export async function setup({ input = process.stdin, output = process.stderr, file = configPath() } = {}) {
  const rl = createInterface({ input, output, terminal: Boolean(input.isTTY) });
  const abort = new AbortController();
  rl.on('SIGINT', () => abort.abort());
  const ask = async prompt => (await rl.question(prompt, { signal: abort.signal })).trim();
  try {
    output.write('\nWelcome to Lyla\nChoose a provider. Settings are saved locally; API keys are not.\n\n  1. OpenAI\n  2. Anthropic\n  3. OpenAI-compatible / local server\n  4. Offline demo (no model or key needed)\n\n');
    let provider;
    while (!provider) {
      const choice = await ask('Provider [1–4]: ');
      provider = { '1': 'openai', '2': 'anthropic', '3': 'openai-compatible', '4': 'demo' }[choice];
      if (!provider) output.write('Enter 1, 2, 3, or 4.\n');
    }
    let model = provider === 'demo' ? 'demo' : '';
    while (!model) model = await ask('Model ID: ');
    let baseUrl;
    if (provider === 'openai-compatible') {
      while (!baseUrl) {
        const candidate = await ask('API base URL (including /v1 if required): ');
        try { validateConfig({ provider, model, baseUrl: candidate }); baseUrl = candidate; }
        catch (error) { output.write(`${error.message}\n`); }
      }
    }
    const config = await saveConfig({ provider, model, baseUrl }, file);
    output.write(`\nSaved ${provider}/${model} to ${file}\n`);
    const key = { openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY' }[provider];
    const ready = !key || Boolean(process.env[key]);
    if (!ready) output.write(`Set ${key} in your shell, then run lyla again. API keys are never saved by setup.\n`);
    return { config, ready };
  } finally { rl.close(); }
}
