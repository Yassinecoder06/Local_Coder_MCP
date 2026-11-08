---
name: test
description: Run the project test suite and analyze any failures
args: [filter]
---

You are running the project test suite. Follow these instructions:

1. Identify the project stack and test runner:
   - Call `workspace_info` to inspect detected stack and package scripts.
2. Run the test command:
   - If a test filter is provided ({{filter}}), run the tests matching that filter.
   - Use the `run` tool to execute the appropriate test command (e.g. `npm test`, `pytest`, `cargo test`, `go test`).
3. If tests pass, report a summary of test results.
4. If any test fails:
   - Analyze the stack trace and failing assertions in the command output.
   - Use the `read` or `search` tool to inspect the failing test file and related source files.
   - Explain the root cause of the failure and suggest a fix.
