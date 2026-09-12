# Lyla

A small, model-agnostic coding harness. A terminal interface, an agent loop,
four local tools, and a durable conversation journal. Node.js 22 or later;
**zero runtime dependencies** and no build step.

Inspired by [Pi's minimal, extensible design](https://pi.dev/). Lyla owns its
agent loop and adapters; it does not wrap Pi or depend on its packages.

## Run

Install the terminal command once from this directory:

```sh
npm link
lyla
```

On first launch, Lyla shows a provider and model picker. Use **↑/↓ and Enter**
to choose, or **Escape** to cancel. It saves those settings to
`~/.config/lyla/config.json`, and opens chat if credentials are available. Choose
offline demo to try the interface without an account. Run `lyla setup` to change
defaults later. API keys stay in environment variables; setup never saves them.
`LYLA_CONFIG_DIR` overrides the settings directory.

OpenAI and Anthropic have a built-in list of named models with exact API IDs;
account access is not guaranteed by appearing in the list. Compatible servers
are queried at `/models` (up to eight choices shown). **Enter a custom model ID**
is always available for other models. Non-TTY interfaces use numbered choices.

From this directory:

```sh
node src/cli.js --demo -p "Hello Lyla"
npm test
```

Demo mode is a fixed offline response used to verify installation. It does not
call a model or perform coding work.

For real work, set your chosen provider's API key in your environment, then run
one of these commands with a model ID available to your account:

```sh
# Reads OPENAI_API_KEY; uses the Responses API
node src/cli.js --provider openai --model YOUR_MODEL_ID

# Reads ANTHROPIC_API_KEY; uses the Messages API
node src/cli.js --provider anthropic --model YOUR_MODEL_ID

# Local or hosted Chat Completions endpoint; optional OPENAI_COMPATIBLE_API_KEY
node src/cli.js --provider openai-compatible --model YOUR_MODEL_ID \
  --base-url http://localhost:11434/v1
```

### Sign in with ChatGPT / Codex

Choose **Sign in with ChatGPT / Codex (OAuth)** in setup, or run:

```sh
lyla login
lyla
```

Inside chat, `/login` signs in and switches the current session. `lyla login`
preserves your selected OpenAI/Codex model and switches saved defaults to the
Codex backend. Other providers use Codex's default model when switching. For a
device-code flow, use `lyla login --device-auth`.

Requires a current official Codex CLI on PATH (`npm install -g @openai/codex`).
Lyla reuses an existing ChatGPT login when available; otherwise Codex opens its
own browser sign-in flow. Codex owns credentials and token refresh. Lyla never
reads `auth.json` or treats an OAuth token as an OpenAI API key. `LYLA_CODEX_BIN`
can specify a different Codex executable.

**Codex mode is an execution backend, not a raw model adapter.** The official
Codex runtime performs coding and tool execution. Lyla journals its JSON events
and final answer, and supplies portable conversation context for each turn.
Codex runs with `workspace-write` sandboxing, no approval prompts, and its user
configuration disabled for execution. Its authentication remains available.
Operations requiring additional permissions fail rather than bypass the sandbox.
This mode has a ten-minute turn timeout; Lyla's `--max-steps` only applies to the
direct API tool loop. Cancellation stops the backend, but cannot undo edits.
Native Codex reasoning state is not resumed between turns in this first version.

Backend events are observational: Lyla flushes `backend_start` before launching
Codex but cannot gate each of Codex's internal actions on journal persistence.
Use the API-key backend when you need Lyla to own and control each tool call.

Compatibility depends on the selected server and model supporting function
tools. The local endpoint above is an example, not an installed service.

For a single turn or a machine-readable event stream:

```sh
node src/cli.js --provider openai --model YOUR_MODEL_ID \
  --cwd /path/to/project -p "Explain the test setup"

node src/cli.js --demo --json -p "Hello"
```

No package installation is needed to run from source. `LYLA_PROVIDER`, `LYLA_MODEL`, and
`LYLA_BASE_URL` can supply defaults instead of command-line flags.

## Inside a session

| Command | Behavior |
| --- | --- |
| `/model PROVIDER MODEL [BASE_URL]` | Switch for later turns; preserve canonical conversation history |
| `/session` | Print the session ID and journal path |
| `/feedback accepted Reviewed the diff` | Explicitly mark the latest message as accepted |
| `/feedback rejected Too much abstraction` | Record rejection without inventing a general rule |
| `/feedback correction Reuse the existing helper` | Record feedback; send a normal follow-up separately to request a change |
| `/new` | Start fresh and reload ancestor `AGENTS.md` instructions |
| `/exit` | Close the session |
| Ctrl+C | Cancel the active turn, or leave an idle prompt |

Resume with the same working directory:

```sh
node src/cli.js --cwd /path/to/project --resume SESSION_ID
```

The journal remembers the provider, model, custom base URL, and system context.
Keys remain in your environment. Explicit CLI/environment settings override
saved provider settings. Native continuation data is reused only where the
adapter considers it compatible; cross-provider translation preserves text and
tool interactions, not private reasoning state.

## Tools and execution boundary

- `read`: UTF-8 file reads with line offset/limit and bounded output.
- `write`: create or overwrite a UTF-8 file; parent directory must already exist.
- `edit`: replace exactly one occurrence of a nonempty string.
- `bash`: execute a bounded shell command, capturing output and exit failures.

**Tools run with your operating-system permissions. The working directory is
not a sandbox.** File paths may be absolute, and shell commands can access other
files or the network. Use a container or restricted account for untrusted work.
There are no built-in approval dialogs. POSIX shell process groups are terminated
on timeout/cancellation; a deliberately detached process can escape that group.

Tool failures are returned to the model as errors so it can inspect and recover.
Shell output is bounded, but no transaction can undo a command's side effects.
The agent stops after a configurable number of model calls (`--max-steps`, 20
by default), on cancellation, or on a provider failure. Provider calls have a
two-minute default timeout. SDK callers can configure it.

## Evidence for future learning

Journals live in `<cwd>/.lyla/sessions/<id>.jsonl` unless `--session-dir` is set.
They record messages, tool starts/results, usage counts when supplied, provider
changes, run outcomes, and explicit feedback. Each event is flushed to disk;
tool-start evidence is flushed **before** a tool executes.

These files can contain source code, private prompts, provider-native response
data, and sensitive command output. They are created with private permissions;
keep `.lyla/` out of version control in each project you work on. This repository
already ignores it. Lyla does not upload its journal independently; the model
provider receives the conversation needed for inference.

Only one process can own a session. After a hard crash, inspect the PID in the
`.lock` file and remove that lock only when the owning process is no longer
running. Resume marks unmatched tool calls as **unknown outcome** and never
automatically replays them. A truncated journal is rejected rather than silently
rewritten; preserve it for manual recovery.

Recorded events are evidence, not a correctness verdict. An agent completing a
turn does not mean you accepted the code or that tests passed.

## Embed or extend

```js
import { Agent, createProvider, createTools } from './src/index.js';

const agent = new Agent({
  provider: createProvider({ provider: 'demo', model: 'demo' }),
  tools: createTools(),
  cwd: process.cwd(),
  system: 'You are Lyla. Make focused changes and verify your work.',
  onEvent: async event => console.log(event.type),
});

const result = await agent.run('Hello');
console.log(result.status);
```

A provider implements `complete({system, messages, tools, signal})`. A tool has
`name`, `description`, JSON Schema `parameters`, and `execute(args, context)`.
See `src/types.js` for the small shared protocol. Validate arguments within custom
tools. `onEvent` is awaited: a failed evidence sink prevents subsequent tool
execution. For persistence, construct/resume a `Session`, pass its `messages`
into the agent, and use `event => session.append(event)` as the sink.

## Current limits

This is a tested foundation, not feature parity with Pi. Responses are currently
non-streaming. There is no automatic context compaction, visual TUI,
MCP client, browser integration, plugin loader, or automatic skill discovery.
Long sessions eventually need `/new` or may exceed a model's context window.

There is **no automatic learning or evaluation promotion yet**. The intended next
layer extracts candidate lessons from sessions, evaluates them independently,
and promotes only evidence-backed procedures. See [the design](docs/design.md).

Offline tests cover Codex subprocess behavior, protocol translation against local HTTP fixtures, tool
execution, cancellation, session recovery, and the CLI. Live authenticated
provider/model interoperability must be verified with your chosen account.
