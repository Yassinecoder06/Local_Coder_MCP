---
name: verify
description: Run project diagnostics and checks after a change, then report concrete results
args: [focus]
---

Verify the implementation, not just that commands start:

1. Inspect the current diff and identify the affected behavior.
2. Run the project's relevant diagnostics and validation commands using `run` with `verify: true` (for example, typecheck, unit tests, build, and focused checks).
3. If the change affects a web page, use `browser_check` on the running page and inspect the returned screenshot.
4. If a check fails, inspect the output and fix the cause before rerunning the relevant checks.
5. Report exactly which checks passed, failed, or could not run, including any remaining limitation.

{{#if focus}}
Focus verification on: {{focus}}
{{/if}}
