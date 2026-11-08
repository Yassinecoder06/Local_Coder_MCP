---
name: ship
description: Validate changes, run tests, review diff, format a clean commit message, and commit
args: [message]
---

You are shipping changes to git. Follow these instructions step by step:

1. Run automated validation:
   - Call `run` with `verify: true` to auto-detect and run project validation checks (typecheck, lint, test, build).
   - If UI or web frontend files were changed, call `browser_check` to ensure the page loads cleanly with no console or page errors.
   - If any checks fail, STOP immediately, analyze the failures, and do not commit broken code.
2. Update task plan:
   - Call `todo` with action "list" to review remaining tasks, and use action "update" to mark finished tasks "done".
3. Review uncommitted changes:
   - Call `git` with subcommand "status" to see modified and untracked files.
   - Call `git` with subcommand "diff" to review exact line changes for unintended edits or secrets.
4. Stage files:
   - Use `git_write` with subcommand "add" and explicit file paths to stage intended changes.
5. Commit:
   - If a message was provided ({{message}}), use it or refine it into a clean conventional commit `<type>(<scope>): <summary>`.
   - Call `git_write` with subcommand "commit" and args `["-m", "<message>"]`.
6. Verify:
   - Call `git` with subcommand "log" and args `["-n", "1", "--oneline"]` to confirm the commit was recorded cleanly.
