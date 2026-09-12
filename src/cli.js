#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Agent } from './agent.js';
import { createProvider } from './providers.js';
import { createTools } from './tools.js';
import { Session, recoverInterruptedCalls } from './session.js';
import { loadContext } from './context.js';

const HELP = `Lyla — a small, model-agnostic coding harness

Usage:
  lyla --demo -p "Hello"
  lyla --provider openai --model <model-id>
  lyla --provider anthropic --model <model-id> -p "Explain this project"
  lyla --provider openai-compatible --model <model-id> --base-url <url>

Options:
  -p, --print TEXT       Run one prompt and exit (also accepts piped stdin)
  --provider NAME       openai | anthropic | openai-compatible | demo
  --model ID            Provider's model id; no hardcoded cloud model default
  --base-url URL        Custom provider API base URL
  --demo                Deterministic offline smoke-test provider, not an LLM
  --cwd PATH            Working directory (default: current directory)
  --resume ID           Resume a session in the selected session directory
  --session-dir PATH    Journal directory (default: <cwd>/.lyla/sessions)
  --max-steps N         Max model calls per user turn (default: 20)
  --json                Emit JSONL events on stdout
  -h, --help            Show this help

Interactive commands:
  /model PROVIDER MODEL Switch provider/model for subsequent turns
  /feedback VERDICT NOTE Record accepted, rejected, or correction feedback
  /session              Print current session id and journal path
  /new                  Start a new session and reload project instructions
  /help                 Show commands
  /exit                 Exit (Ctrl+C cancels an active turn)

Environment: LYLA_PROVIDER, LYLA_MODEL, LYLA_BASE_URL; provider API keys
OPENAI_API_KEY, ANTHROPIC_API_KEY, or OPENAI_COMPATIBLE_API_KEY.

Tools read, write, edit, and run shell commands with your user permissions.
Use a trusted working directory or an external sandbox. Journals contain prompts,
code, and tool output; keep them private. Lyla never infers user acceptance.
`;

export function parseArgs(argv) {
  const options = { cwd: process.cwd(), maxSteps: 20, json: false };
  const values = { '--provider': 'provider', '--model': 'model', '--base-url': 'baseUrl', '--cwd': 'cwd', '--resume': 'resume', '--session-dir': 'sessionDir', '--max-steps': 'maxSteps', '-p': 'prompt', '--print': 'prompt' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--demo') options.demo = true;
    else if (values[arg]) {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new Error(`Missing value for ${arg}.`);
      options[values[arg]] = argv[++i];
    } else throw new Error(`Unknown option: ${arg}. Try --help.`);
  }
  options.maxSteps = Number(options.maxSteps);
  if (!Number.isSafeInteger(options.maxSteps) || options.maxSteps < 1 || options.maxSteps > 1000) throw new Error('--max-steps must be an integer from 1 to 1000.');
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) { process.stdout.write(HELP); return; }
  const cwd = await realpath(resolve(options.cwd));
  const directory = resolve(options.sessionDir ?? resolve(cwd, '.lyla/sessions'));
  let session;
  let agent;
  let controller;
  let rl;
  const display = event => {
    if (options.json) { process.stdout.write(`${JSON.stringify(event)}\n`); return; }
    if (event.type === 'message' && event.message.role === 'assistant' && event.message.content) {
      process.stdout.write(`${event.message.content}\n`);
    }
    if (event.type === 'tool_start') process.stderr.write(`  → ${event.name ?? event.toolCall?.name ?? event.call?.name ?? 'tool'}\n`);
  };
  const sink = async event => display(await session.append(event));

  async function initialize(resume) {
    let context;
    if (resume) {
      session = await Session.resume(directory, resume);
      if (session.metadata.cwd !== cwd) throw new Error(`This session belongs to ${session.metadata.cwd}. Resume with that --cwd.`);
    } else context = await loadContext(cwd);
    const lastProvider = session?.events.findLast(e => e.type === 'provider_change') ?? session?.metadata;
    const providerName = options.demo ? 'demo' : options.provider ?? process.env.LYLA_PROVIDER ?? lastProvider?.provider;
    const model = options.demo ? 'demo' : options.model ?? process.env.LYLA_MODEL ?? lastProvider?.model;
    if (!providerName || !model) throw new Error('Choose --provider and --model, or use --demo for an offline smoke test. See --help.');
    const provider = createProvider({ provider: providerName, model, baseUrl: options.baseUrl ?? process.env.LYLA_BASE_URL });
    if (!session) session = await Session.create(directory, { cwd, provider: provider.id, model: provider.model, system: context.system });
    else {
      await recoverInterruptedCalls(session);
      if (lastProvider.provider !== provider.id || lastProvider.model !== provider.model) {
        await sink({ type: 'provider_change', provider: provider.id, model: provider.model });
      }
    }
    agent = new Agent({ provider, tools: createTools(), system: session.metadata.system, cwd, messages: session.messages, maxSteps: options.maxSteps, onEvent: sink });
    if (options.json) display({ type: 'session', id: session.id, file: session.file, provider: provider.id, model: provider.model });
    else process.stderr.write(`Lyla · ${provider.id}/${provider.model}\nSession ${session.id}\n`);
  }

  async function run(prompt) {
    if (!prompt.trim()) throw new Error('Prompt cannot be empty.');
    controller = new AbortController();
    try {
      const result = await agent.run(prompt, { signal: controller.signal });
      if (result.status !== 'completed') {
        process.stderr.write(`Turn ${result.status}${result.error ? `: ${result.error}` : ''}.\n`);
      }
      return result;
    } finally { controller = undefined; }
  }

  const interrupt = () => {
    if (controller) controller.abort();
    else rl?.close();
  };
  process.on('SIGINT', interrupt);
  try {
    await initialize(options.resume);
    if (options.prompt !== undefined || !process.stdin.isTTY) {
      let prompt = options.prompt;
      if (prompt === undefined) {
        prompt = '';
        for await (const chunk of process.stdin) {
          prompt += chunk;
          if (Buffer.byteLength(prompt) > 1024 * 1024) throw new Error('Piped prompt exceeds 1 MiB.');
        }
      }
      const result = await run(prompt);
      if (result.status !== 'completed') process.exitCode = result.status === 'cancelled' ? 130 : 1;
      return;
    }
    process.stderr.write('Type /help for commands. Tools run locally with your permissions.\n');
    rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    rl.on('SIGINT', interrupt);
    rl.setPrompt('lyla › ');
    rl.prompt();
    for await (const line of rl) {
      const text = line.trim();
      try {
        if (text === '/exit' || text === '/quit') break;
        if (text === '/help') process.stderr.write(HELP);
        else if (text === '/session') process.stderr.write(`${session.id}\n${session.file}\n`);
        else if (text === '/new') {
          options.provider = agent.provider.id;
          options.model = agent.provider.model;
          await session.close();
          session = undefined;
          await initialize();
        } else if (text.startsWith('/model ')) {
          const parts = text.split(/\s+/);
          if (parts.length !== 3) throw new Error('Usage: /model PROVIDER MODEL');
          const provider = createProvider({ provider: parts[1], model: parts[2], baseUrl: parts[1] === agent.provider.id ? options.baseUrl ?? process.env.LYLA_BASE_URL : undefined });
          await sink({ type: 'provider_change', provider: provider.id, model: provider.model });
          agent.setProvider(provider);
          options.demo = false;
          options.provider = provider.id;
          options.model = provider.model;
          if (parts[1] !== session.metadata.provider) options.baseUrl = undefined;
          process.stderr.write(`Using ${provider.id}/${provider.model}.\n`);
        } else if (text.startsWith('/feedback ')) {
          const match = /^\/feedback\s+(accepted|rejected|correction)(?:\s+([\s\S]*))?$/.exec(text);
          if (!match) throw new Error('Usage: /feedback accepted|rejected|correction [note]');
          const event = await session.feedback(match[1], match[2] ?? '');
          if (options.json) display(event);
          else process.stderr.write('Feedback recorded. It has not been turned into a rule.\n');
        } else if (text.startsWith('/')) throw new Error('Unknown command. Use /help.');
        else if (text) await run(text);
      } catch (error) { process.stderr.write(`${error.message}\n`); }
      rl.prompt();
    }
  } finally {
    process.removeListener('SIGINT', interrupt);
    rl?.close();
    await session?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write(`Lyla: ${error.message}\n`); process.exitCode = 1; });
}
