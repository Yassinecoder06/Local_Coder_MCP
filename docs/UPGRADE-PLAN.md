# Upgrade plan — ideas from `chat-on-steroids`

Reference: github.com/totec448-spec/chat-on-steroids (MIT, ~5k stars). It is an **Electron desktop app +
Chrome extension** that exposes local tools to ChatGPT over MCP *and* drives the ChatGPT web UI itself
(detects turn end, types follow-ups, opens worker chats). We stay a Dockerized, client-neutral MCP server;
we borrow the parts that fit.

## What they have that we don't

| Feature | Theirs | Ours today | Worth it? |
|---|---|---|---|
| `exec` code mode | One tool runs a JS program (worker_threads isolate) that calls the other tools, `Promise.all`, returns only `text()`/`image()`. 32 calls / 60 s / 2 s CPU / 32 MiB. | none | **Yes — fixes the per-turn tool-call cap** |
| Batched shell | `exec_command` takes `cmds[]` (≤ 20), one shell, labeled sections + exit codes | single `command` | **Yes** |
| Big batched reads | `read` 256 KB/file, 512 KB/call, globs, dir listing | smaller caps, separate `list` | **Yes** |
| Interactive sessions | `write_stdin` writes to / polls a live command by `session_id` | `job` (read only) | Yes |
| Human step | `ask_user_to_run` + `user_request_status`: card with Copy / Done / Skip, never runs anything | none | **Yes** (sudo, logins, OAuth) |
| Finish checkpoint | `session_finish`: model declares done with a summary | none | Yes, with verification evidence |
| Live plan | `update_plan` shown in the app | `todo` (not shown) | Yes, show in UI |
| Plugins hub | Proxies external MCP servers (npm/uv/HTTP/MCPB) behind a separate tokenized endpoint, with per-tool enable and caps of 256 tools / 250 KB | none | **Yes** |
| Command policy | Optional allowlist/denylist argv rules, off by default | approval modes only | Yes (cheap) |
| Separate connectors | Core / Desktop / Plugins endpoints keep each tool list small | one endpoint | Yes, by path |
| Browser companion | An extension drives the user's real Chrome tabs (snapshot, action, console, network) | headless `browser_check` | Later |
| Goal / Loop / Workers / Compact & Resume | The extension watches the ChatGPT page, auto-sends "continue", and opens parallel worker chats | none; the model can't be woken | Optional, high risk (see below) |
| Electron app, pets, desktop computer-use, dictation, i18n, release tooling | — | — | **No** |

## Phases (owner in brackets)

### Phase 1 — Spend fewer tool calls (highest value)
1. **`exec` tool** [agy2]: a JS runtime in `node:worker_threads` with `resourceLimits`. It has `tools.<name>(args)` bound to our own handlers, `text()`, `image()` and `ALL_TOOLS`. There is no fs, network, require or timers. Limits: 64k source chars, 32 calls, 8 concurrent, 60 s wall time, 2 s CPU, 40 KB text, 4 images. No recursive `exec`. The risk is the strongest of any tool it calls (exec). Every inner call is logged to activity under the parent call.
2. **`run` with `cmds[]`** [agy2]: up to 20 commands in one bash session, each with a labeled output and its own exit code. A non-zero exit doesn't stop the batch; the call's exit code is the first non-zero one.
3. **`read` upgrades** [agy2]: 256 KB per file and 512 KB per call by default, glob expansion, and reading a directory lists it one level deep. Keep `list` as a deprecated alias.
4. **`run` interactive sessions** [agy2]: `stdin` / `poll` on a job id (the `write_stdin` idea), reusing `job`.
5. **Instructions** [agy1]: "prefer `exec` for 3+ related calls; batch with `cmds[]`".

### Phase 2 — Human in the loop and a proven finish
6. **`ask_user` / `user_request_status`** [agy2 tool, agy1 API, codex1 UI]: the model hands over one exact command (folder, purpose, expected files). The admin UI shows a card with Copy, Done and Skip. The status tool reports whether the expected files exist. It never runs anything.
7. **`finish` tool** [agy2]: summary, changed files and verification evidence. The server checks evidence: the latest `verify` run, a `browser_check` and git diff stats. The UI shows a "Done" card, and a later `resume` reads it.
8. **Live plan panel** [codex1]: show `todo` and `finish` state per session on the Activity page, through SSE.

### Phase 3 — Plugins hub
9. **Proxy external MCP servers** [agy1]:
   - Stdio servers (pinned npm `npx` or `uvx`) and remote Streamable HTTP servers, configured in `DATA_DIR/plugins.json`.
   - Served at a separate `/mcp/plugins/<token>` endpoint, keeping the upstream tool names and schemas.
   - Caps of 256 tools and 250 KB of schemas.
   - Per-tool enable and disable.
   - Calls are never retried automatically.
   - Read-only or trust annotations from upstream are passed through, never widened.
10. **Plugins page** [codex1]: an add dialog with recipes (Playwright MCP, Fetch, Memory, GitHub), a status pill (Ready only after discovery succeeds), and tool toggles.
11. **Image and runtime support** [codex2]: node and uv in the image, plus a plugin cache volume.
    - Completed: plugin tools are also available through `plugin_tools` and eligible `exec` calls on the main connector; plugin schemas are normalized, and pasted configurations have an import preview.

### Phase 4 — Safety and surfaces
12. **Command policy** [agy2 enforcement, codex1 UI]:
    - Off, allowlist or denylist mode, with exact argv rules and a trailing `*`.
    - Compound or ambiguous shell syntax is rejected while the policy is on.
    - It is a launch policy, not a sandbox, and the docs say so.
13. **Read-only mode** [agy1]: a single switch that hides write and exec tools.
14. **Split endpoints** [agy1, codex2 docs]:
    - `/mcp/core/<t>` (files, run, git), `/mcp/browser/<t>` (browser tools) and `/mcp/plugins/<t>`.
    - `/mcp/<t>` stays as today's combined endpoint.

### Phase 5 — Optional: browser companion extension (decide later)
15. A Chrome extension (Manifest V3) that pairs with the admin API. Two possible uses:
    - (a) **Browser tools** on the user's real tabs: snapshot, click, fill, console and network. This one is low risk and useful.
    - (b) **Goal / Loop**: watch the ChatGPT or Gemini page for the end of a turn and auto-send "continue" until `finish` is called. This is the only way to "wake" a web model. Its README warns that this automates the provider's UI, which isn't a public API, and may break those providers' terms. The DOM changes often, so each site needs its own adapter. Recommendation: build (a); build (b) only as opt-in, off by default, behind a warning.

## Not taking
The Electron shell, OS keychain, pets, native desktop input, dictation, release and signing pipeline, 13 locales, and the worklog-heavy docs.

## Order and size
- Phase 1: about 1 agent-day. It directly fixes "tool-call limit per turn reached".
- Phase 2: about 1 day.
- Phase 3: about 2 days.
- Phase 4: about 1 day.
- Phase 5(a): about 2 days.

Each phase ships on its own, with tests and e2e coverage, and is merged and deployed separately.

License: MIT. If we copy code (not only ideas), keep their copyright notice in `THIRD-PARTY-NOTICES`.
