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
