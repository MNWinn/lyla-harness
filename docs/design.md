# Lyla: a small harness that can later learn

## Question

Can an agent learn from completed work and human corrections, retain what helped,
and improve on new tasks as models, tools, and codebases change?

The first milestone is the harness. It must do useful work and preserve evidence
before it can support defensible claims of improvement.

## Current architecture

```text
CLI / embedding application
          |
        Agent ---- Provider adapter ---- Model API
          |
       Tool registry ---- read / write / edit / bash
          |
    Awaited event callback
          |
    Append-only session journal
```

The model provider is replaceable. The agent owns canonical conversation state,
the sequential tool loop, cancellation, and a model-call bound. Tools own argument
validation and execution. The journal owns ordered durable evidence. The terminal
owns presentation and explicit user feedback.

The optional `CodexAgent` backend supports ChatGPT OAuth through the official
Codex CLI. It delegates execution instead of adapting OAuth credentials to an API.
Lyla saves `backend_start` before launch and `backend_event` records afterward;
per-action flush-before-execute guarantees apply only to Lyla's direct API loop.
The backend uses a fresh ephemeral Codex run with portable conversation context
on each turn. Credential storage and refresh remain entirely with Codex.

Provider-native fields stay alongside canonical text/tool messages so an adapter
can continue its model's protocol without forcing the core to understand it.
Switching models can discard native fields without discarding the user's work.

Project `AGENTS.md` content is captured in the initial system context. Resuming a
session preserves that context; `/new` reloads it. This makes context changes
explicit, which matters for later comparisons.

## Event vocabulary

Each persisted record has `version`, monotonic `seq`, and ISO `at`. Event types:

- `session_start`: working directory, provider/model, base URL, system context.
- `run_start`: model identity for a user turn.
- `message`: canonical user, assistant, or tool message.
- `usage`: reported input/output token counts; not a billed-cost estimate.
- `tool_start`: tool call recorded before execution.
- `tool_result`: tool result event, in addition to its canonical message.
- `run_error`, `run_end`: operational outcome, not task-quality grading.
- `provider_change`: selected provider/model for subsequent turns.
- `feedback`: explicit verdict/note anchored to a message sequence.

Consumers reconstruct conversation history from `message` events only, avoiding
duplicate results. Durability failure stops progress. An interrupted call has an
unknown outcome; neither the journal nor the agent assumes it is safe to replay.

## Subsequent milestones

1. **Evaluation records:** store task criteria, test commands/results, relevant
   code revisions, environment identity, and explicit acceptance. Add controlled
   comparison fixtures. Do not confuse a model's self-report with a test result.
2. **Candidate extraction:** derive scoped lessons or parameterized workflows
   from traces and corrections. Preserve provenance and counterexamples.
3. **Independent evaluation:** compare with a baseline on unseen tasks and repeat
   runs. Check correctness first, then cost, latency, and avoidable corrections.
   Keep graders and held-out cases outside the candidate's editable scope.
4. **Library and retrieval:** separate candidate, validated, needs-repair, and
   retired procedures. Each entry states scope, prerequisites, and evidence.
5. **Maintenance:** trigger targeted retesting on model, tool, website, or codebase
   changes. Retire guidance that no longer helps. Promotion is a decision based on
   evidence, not merely a count of successful executions.

Coding and browser tasks share the evidence loop but need different graders.
Coding can use tests and review comparisons. Browsers need controlled fixtures
plus live outcome checks. Subjective preferences need human calibration; model
judges alone cannot prove correctness.

## Deliberate boundaries

The initial library is not implemented. Sessions do not automatically mutate
AGENTS.md, install tools, change tests, or declare themselves verified. File tools
have no security sandbox. Raw journals need careful handling and eventual
redaction/retention controls before organizational deployment.

Future changes should justify their size with a real use case. Keep the basic
agent loop independently testable and avoid embedding browser-specific or
evaluation-specific policy in it.
