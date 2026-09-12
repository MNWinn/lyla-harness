# Lyla extension contract v1

Lyla 0.1 supports contract version 1. Runtime dependencies remain zero. Evaluation
policy belongs in packages. An extension is trusted executable local JavaScript;
this contract is not a sandbox. Journals, project content and context text remain
untrusted inputs. Hooks do not expand tool permissions.

```json
{"name":"@owner/package","version":"0.1.0","type":"module",
 "lylaExtension":{"id":"example","contractVersion":1,"entry":"./src/index.js"}}
```

An unsupported contract is rejected before importing code. Entry points must stay
inside the package. Export `async function activate(host)` (or default), optionally
returning an async disposal function or `{dispose()}`. Installed npm code must be prebuilt; install
scripts are disabled. Local packages are copied into a snapshot, excluding `.git`,
`node_modules`, `.lyla`, `.env*`, `secrets`, `.DS_Store`, and archive/key files.
Local symlinks are rejected; snapshots are bounded to 20,000 entries and 128 MiB.
A package `files` array is honored as literal relative files/directories; glob
patterns are rejected for local installation. Package metadata, README and LICENSE
are included. Sources cannot contain their installation directory; zero-dependency packages need no download. Package
runtime dependencies require an npm installation or a self-contained build.

## Host API

- `registerCommand(name, async (args, context) => {})`: unprefixed top-level name,
  routed from `/name ...` or `lyla name ... --cwd PATH`. Reserved/duplicate names
  fail activation. Offline commands do not initialize a provider or authenticate.
- `onRunStart(async context => {})`: awaited before `run_start` and execution;
  includes `prompt`. Failure stops the turn.
- `onEvent(async (event, context) => {})`: observes persisted events, including
  feedback. Observer failure is surfaced and stops an active turn.
- `contributeContext(async context => [{id, version, text, ...attribution}])`:
  fresh contributions before each direct model request; `requestIndex` starts at
  zero. Codex offers one `backend-turn` hook, not internal request visibility.
- `storageDir`: private persistent extension directory.
- `append(event)`: durable namespaced session event; it does not recursively
  notify observers. No session exists for offline commands, so use `storageDir`
  for command artifacts.
- `getContext()`: immutable snapshot containing `cwd`, optional `sessionId`,
  `journalPath`, `provider: {id, model, reasoning, baseUrl}`, and tool names.
  `harnessVersion`, `toolFingerprint` (SHA-256 of tool implementation), and
  `capabilities` identify direct-request or delegated-turn injection and telemetry.
- `runtime`: `Agent`, `createProvider`, `createTools`, `Session`, `loadContext`.
- `report(text)`: write command output.

Contexts/events/arguments are cloned and frozen. Contributions are cloned,
validated and selected whole in registration order within 8192 UTF-8 bytes
(configurable via `LYLA_EXTENSION_CONTEXT_BYTES`). The budget includes separators.
Each request first durably records `context_injection` with accepted entries,
versions, text, attribution, omissions, bytes, request index and injection scope.
No contribution is added permanently to conversation history. Append failure
prevents inference. Core does not decide whether text is approved or relevant.

Standalone `Agent` and `CodexAgent` also accept awaited `beforeRun(context)` and
`beforeRequest(context)` callbacks. The latter returns temporary system text;
callers own persistence when not using the extension host.

## Lifecycle

```sh
lyla install local /absolute/package/path
lyla install npm:@owner/package@0.1.0
lyla extensions list
lyla extensions disable example
lyla extensions enable example
lyla extensions update example
lyla extensions update example --version 0.2.0
lyla extensions remove example
```

Installation enables extension code; it never approves its generated content.
Registry changes take effect in the next Lyla process (or new session). Local
updates copy a fresh snapshot. Npm installations use a dedicated directory and
lockfile, with exact resolved package version recorded. Failed updates leave the
previous registration intact. Registry mutations use an exclusive lock; contention
retries briefly and fails clearly. Each registration records SHA-256 integrity of
the complete installed snapshot, including dependency files and npm lockfiles.
Loading verifies integrity before importing code; tampered packages require reinstall. Disable/removal preserve storage and package
snapshots; no evidence is implicitly deleted. Old snapshots also preserve modules
used by existing processes. Data is under `LYLA_CONFIG_DIR/extensions` (normally
`~/.config/lyla/extensions`). Back up that directory before manual cleanup.
