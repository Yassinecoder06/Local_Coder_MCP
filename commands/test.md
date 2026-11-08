---
name: test
description: Run the project test suite and analyze any failures
args: [filter]
---

You are running the project test suite. Follow these instructions:

1. Identify the project stack and test runner:
   - Call `workspace_info` to inspect detected stack and package scripts.
2. Run project verification:
   - If no specific filter is provided, call `run` with `verify: true` to auto-detect and sequentially run all validation checks (typecheck, lint, test, build).
   - If a test filter is provided ({{filter}}), use `run` with the specific test command targeting that filter (e.g. `npm test -- {{filter}}`, `pytest -k {{filter}}`).
   - If frontend web components or pages are tested, call `browser_check` to verify UI rendering, console logs, and network errors.
3. If tests pass:
   - Report a clear summary of passed checks and duration.
   - Update `todo` to mark testing tasks as "done".
4. If any test fails:
   - Analyze the errors array and command tail returned by `run`.
   - Use `read` or `search` to inspect the failing test file and related source files.
   - Use `todo` to record reproduction and fix tasks.
   - Explain the root cause of the failure and suggest a fix.
