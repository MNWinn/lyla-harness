# Lyla

Build a minimal, model-agnostic coding harness. Node.js 22+, ESM JavaScript,
zero runtime dependencies, Node's built-in test runner. Keep providers, the
agent loop, tools, persistence, and terminal presentation independently usable.

Do not add an autonomous learning loop yet. Preserve session evidence and
explicit user feedback so evaluation can be implemented independently later.
Treat model output and project files as untrusted inputs. Never claim a shell
working directory is a security sandbox. Validate tool arguments before writes.

Run `npm test` and CLI smoke tests before delivering. Live provider tests need
credentials; use local HTTP fixtures for repeatable protocol coverage.
