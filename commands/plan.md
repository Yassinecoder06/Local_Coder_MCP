---
name: plan
description: Plan a feature implementation or architectural change before writing code
args: [feature]
---

You are planning the implementation of a new feature or change: {{feature}}

1. Explore existing architecture:
   - Call `resume` if continuing previous work, or `workspace_info` to understand the stack and conventions.
   - Use `list` to inspect project directory structure.
   - Use `search` and `read` to check existing patterns and utilities in related modules.
2. Formulate a structured step-by-step implementation plan:
   - Identified files to modify or create
   - Data structures, interfaces, and API contracts
   - Migration or backward-compatibility considerations
   - Verification strategy (run `run` with `verify: true`, unit tests, browser_check for UI)
3. Record the plan in agent memory:
   - Call `todo` with action "set" and an array of items representing each task.
   - As you execute each step, call `todo` with action "update" to mark items "in_progress" and "done".
4. Present the plan clearly and ask for confirmation before making edits.
