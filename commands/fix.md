---
name: fix
description: Diagnose and fix an error, bug, or failing test
args: [issue]
---

You are diagnosing and fixing an issue in the project. Follow these instructions:

1. Understand the issue: {{issue}}
2. Locate the relevant code:
   - Use `search` with mode "content" to find error messages, function names, or identifiers.
   - Use `read` to inspect suspect files.
3. If applicable, run tests using `run` to reproduce the failure.
4. Apply the necessary fix:
   - Use `edit` for targeted string replacements or `write` / `apply_patch` for broader changes.
5. Verify the fix:
   - Run the test suite or build command via `run` to ensure no regressions were introduced.
6. Summarize the root cause, what changes were made, and how verification was performed.
