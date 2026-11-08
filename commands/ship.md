---
name: ship
description: Validate changes, run tests, review diff, format a clean commit message, and commit
args: [message]
---

You are shipping changes to git. Follow these instructions step by step:

1. Run the test suite:
   - Call `workspace_info` to identify test runner scripts if unknown.
   - Execute the test command using `run` (e.g. `npm test`, `cargo test`, `pytest`).
   - If tests fail, STOP immediately, analyze the failures, and do not commit broken code.
2. Review uncommitted changes:
   - Call `git` with subcommand "status" to see modified and untracked files.
   - Call `git` with subcommand "diff" to review exact line changes for unintended edits or secrets.
3. Stage files:
   - Use `git_write` with subcommand "add" and explicit file paths to stage intended changes.
4. Commit:
   - If a message was provided ({{message}}), use it or refine it into a clean conventional commit `<type>(<scope>): <summary>`.
   - Call `git_write` with subcommand "commit" and args `["-m", "<message>"]`.
5. Verify:
   - Call `git` with subcommand "log" and args `["-n", "1", "--oneline"]` to confirm the commit was recorded cleanly.
