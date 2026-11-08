---
name: resume
description: Resume unfinished work from the workspace checklist and current repository state
args: [focus]
---

Resume the next unfinished task:

1. Read `TODO.md` if present, then inspect the working tree and recent changes.
2. Reconcile checklist items with the current files and completed work; do not repeat finished or destructive actions.
3. Continue the highest-priority unfinished item, updating the checklist as work progresses.
4. Run relevant diagnostics and report what remains.

{{#if focus}}
Resume with priority on: {{focus}}
{{/if}}
