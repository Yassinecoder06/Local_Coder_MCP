---
name: commit
description: Stage and commit changes with a clean conventional commit message
args: [message]
---

You are preparing a git commit. Follow these instructions:

1. Check current git status:
   - Call `git` with subcommand "status".
2. Inspect changes to ensure only intended files are committed:
   - Call `git` with subcommand "diff" to review all changes.
3. Stage files:
   - Use `git_write` with subcommand "add" and specific file paths (avoid bare `.` if untracked temporary files exist).
4. Commit changes:
   - If a message was provided ({{message}}), use it or formulate a clean conventional commit message matching `<type>(<scope>): <summary>`.
   - Call `git_write` with subcommand "commit" and args `["-m", "<message>"]`.
5. Verify the commit was recorded:
   - Call `git` with subcommand "log" and args `["-n", "1"]`.
