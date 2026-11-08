---
name: explain
description: Explain how a file, function, or system component works
args: [target]
---

You are explaining a component of the codebase: {{target}}

1. Locate the target:
   - Use `search` with mode "files" to find relevant file paths.
   - Use `search` with mode "content" to find definitions or references.
2. Read the source code using the `read` tool.
3. Trace data flow, dependencies, and interactions with other modules.
4. Provide a clear explanation structured as:
   - Purpose and Responsibility
   - Key Functions / Methods and their behaviors
   - Data structures and state management
   - Edge cases or potential caveats
