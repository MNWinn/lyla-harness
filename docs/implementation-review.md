# Foundation review

Baseline: a working terminal and SDK harness; real provider adapters; read,
write, exact edit, and bounded shell tools; durable sessions and explicit feedback;
no automatic promotion of lessons. Offline tests must cover tool loops, failure
paths, provider wire formats, persistence, and CLI behavior.

Approval scorecard (0–5): correctness, test coverage, maintainability,
architectural fit, risk profile. Target: each at least 4; no unresolved critical
findings. Review is a human/agent assessment, not a statistical reliability claim.

Strategies: provider portability; conservative coding tools; minimal agent core;
failure-focused independent review; integration and CLI review. Work is isolated
in candidate worktrees and converged into Lyla's main working directory.

## Final decision

Five isolated worktrees were used for the five strategies above. Provider, tools,
and core implementations were integrated as separate modules; the review and
integration worktrees supplied independent findings and regression tests. The
convergence branch is `codex/lyla-converged`.

All three implementation candidates were accepted after integration and fixes.
Review caught invalid empty assistant messages after cross-model truncation,
linked-command startup, and endpoint persistence/switching edge cases. The final
implementation includes regression coverage and bounded context loading.

Independent review of `fac4533`: no blocking findings. Scores: correctness 4.5,
tests 4.5, maintainability 4.5, architectural fit 5, risk profile 4.5 (out of 5).

Verification: 36 passing Node tests, including child-process CLI tests and local
HTTP provider fixtures. An interactive PTY smoke test exercised a demo turn,
feedback recording, model switching, a new session, and exit. No live paid model
requests were made. Live credentialed integration and broader provider/model
coverage remain necessary before production use. No claim of autonomous learning
or sandbox isolation is made.
