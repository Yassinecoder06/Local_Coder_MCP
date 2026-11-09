---
name: delegate
description: Hand a task to a herdr agent and wait for its report in a single tool call
args: [agent, task]
---

You are delegating a task to another agent managed by Herdr. Follow these instructions to minimize tool calls:

1. Target agent: {{agent}}
2. Task: {{task}}

Execute the delegation efficiently:
- For short tasks, prompt the agent, wait for it to settle, and read its output in a single `run` call:
  ```bash
  herdr agent prompt {{agent}} "{{task}}" --wait --until done --until idle && herdr agent read {{agent}}
  ```
- For long or multi-line tasks:
  1. Write the full task instructions into `TASK.md` in the target worktree using `edit_files` (op: "write").
  2. Send the prompt and read the output in a single `run` call:
     ```bash
     herdr agent prompt {{agent}} "read TASK.md and do it. Delete TASK.md when done." --wait --until done --until idle && herdr agent read {{agent}}
     ```
- Never use `herdr pane run` on an agent pane.
- Never dump environment variables or inspect agent wrapper scripts.
- Report the agent's completion output back to the user once the command finishes.
