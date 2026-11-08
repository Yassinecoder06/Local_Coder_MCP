---
name: fix
description: Diagnose and fix an error, bug, or failing test
args: [issue]
---

You are diagnosing and fixing an issue in the project. Follow these instructions:

1. Understand the issue: {{issue}}
   - Record steps in `todo` (action: "set" or "update") to track diagnosis and resolution.
2. Locate the relevant code:
   - Use `search` with mode "content" to find error messages, function names, or identifiers.
   - Use `read` to inspect suspect files.
3. Reproduce the failure:
   - Run tests using `run` (or `run` with `verify: true`) to confirm the failure.
   - If UI or browser-related, call `browser_check` to capture console logs, page errors, and visual state.
4. Apply the necessary fix:
   - Use `edit_files` (`op: "replace"`, `op: "write"`, or `op: "patch"`) for changes.
   - Inspect the returned `data.diagnostics`; if any errors are reported, fix them before moving on.
5. Verify the fix:
   - Call `run` with `verify: true` to run all project checks and ensure no regressions.
   - If UI was changed, call `browser_check` to confirm clean rendering without console errors.
   - Update `todo` to mark the task "done".
6. Summarize the root cause, what changes were made, and how verification was performed.
