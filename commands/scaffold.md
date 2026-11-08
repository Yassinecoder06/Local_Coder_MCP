---
name: scaffold
description: Scaffold a new component, module, or test following project conventions
args: [name]
---

You are scaffolding a new module or component: {{name}}

1. Discover project conventions:
   - Call `workspace_info` to check stack and configuration.
   - Use `search` with mode "files" to find existing components or modules for reference.
   - Read an existing module with `read` to match formatting, typing, and testing conventions.
2. Create necessary files:
   - Use `edit_files` (`op: "write"`) to create the new module file(s).
   - Use `edit_files` (`op: "write"`) to create a corresponding unit test file.
3. Wire the new component:
   - If an index/barrel export or route registration is needed, use `edit_files` (`op: "replace"`) to update the parent module.
4. Run static analysis or tests:
   - Call `run` with `npm run typecheck` or test suite to ensure the scaffold compiles cleanly.
