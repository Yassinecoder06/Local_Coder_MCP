---
name: herdr-web
description: "Orchestrating herdr agents from a web chat through Local Coder. Use when managing, dispatching, or inspecting background agents across panes and worktrees."
---

For the full herdr command reference also load `herdr`.

## Web-chat playbook

- `run` executes **inside the container**, with access only to the mounted project folder. It cannot see host `~/.local/bin` or host processes in `ps`. `herdr pane run` and agent prompts execute on the **host**; use Herdr for host-only CLIs.
- Before every agent dispatch, resolve pane IDs from `herdr agent list`, matching cwd/worktree and agent. Never infer IDs from ordering or pane titles. Re-check the list after creating tabs.
- Verify progress with agent state, recent output, and the worktree git state together. `working` does not mean productive; `idle` does not mean finished. Classify as working, waiting for input (a prompt, approval, or “continue” is visible), finished (commit present and `TASK.md` deleted), or failed.
- Run the following checks as one `run({ cmds: [...] })` batch or one exec call, so they use one tool call (replace placeholders with the resolved pane and worktree):
  ```sh
  herdr agent list
  herdr agent read <pane> --source recent-unwrapped --lines 30
  git -C <worktree> log -1 --oneline
  git -C <worktree> status --short --branch
  ```
- For waits, start `herdr agent wait <pane> --until idle --until done --timeout 120000` as a `run` job, then poll it with `job`; keep each web-chat tool call short.
- Start dev servers with `run({ service: "dev", command: "npm run dev", port: 5173 })`. Do not use `nohup` or `&`.

## Web chat playbook

Web chat clients (ChatGPT, Gemini) cap tool calls per reply (~10-20). Conserve tool turns when coordinating:
- **Discovery (1 call)**: run `herdr agent list` to find active agents and their pane IDs.
- **Delegation (1 call)**: combine prompt and read in a single `run` call:
  `herdr agent prompt <pane> "<task>" --wait --until done --until idle && herdr agent read <pane>`
- **Long tasks**: write instructions to a file (e.g. `TASK.md`) in the worktree, then prompt: `read TASK.md and do it`.
- **Never inspect internals**: do not cat wrapper scripts or dump environment variables.
- **Never use `pane run` on agent panes**: use `herdr agent prompt` so Herdr tracks lifecycle states.
- **Never kill or restart agents** unless explicitly asked by the user.
- **Verify flags**: check `herdr --help` or `herdr agent --help` directly when needed.
