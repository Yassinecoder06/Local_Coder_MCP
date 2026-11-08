---
name: review
description: Review uncommitted changes or branch diff for bugs, edge cases, and quality
args: [focus]
---

You are performing a comprehensive code review. Follow these instructions:

1. Inspect modified and unstaged files using the `git` tool:
   - Call `git` with subcommand "status".
   - Call `git` with subcommand "diff" to view unstaged changes.
   - If changes are staged, call `git` with subcommand "diff" and args `["--staged"]`.
2. For each modified file of interest, read surrounding context using the `read` tool.
{{#if focus}}
3. Focus your review specifically on: {{focus}}
{{/if}}
4. Verify correctness, edge cases, error handling, and potential regressions.
5. Provide a clear, actionable summary with line-level suggestions if issues are found.
