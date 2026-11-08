---
name: deps
description: Audit dependencies for updates, security advisories, and unused packages
args: [action]
---

You are auditing or managing project dependencies: {{action}}

1. Inspect project dependency declarations:
   - Use `read` to check `package.json`, `Cargo.toml`, `go.mod`, or `requirements.txt`.
2. Check for security vulnerabilities or outdated packages:
   - Use `run` to execute security auditing commands (e.g. `npm audit`, `cargo audit`, `pip audit`).
3. If updates or additions were requested:
   - Verify compatibility before updating.
   - Run `npm test` or the project test suite via `run` to confirm no regressions.
4. Report audit results, vulnerabilities resolved, or changes made.
