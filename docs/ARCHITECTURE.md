# Architecture & contracts (source of truth for all agents)

```
ChatGPT web / Gemini web ──HTTPS──► tunnel (cloudflared, optional) ──► :8787  MCP server (public: /mcp, /oauth/*, /.well-known/*, /health)
Browser on host ─────────────────────────────────────────────────────► :8788  Admin UI + REST API (bound to 127.0.0.1 on the host)
```
One Node 22 process, two listeners, runs in Docker (`compose.yaml`). Project folders are bind-mounted at the
**same absolute path** as on the host, container runs as host UID/GID, state lives in `DATA_DIR` (`/data` volume).

## Source layout & ownership
| Path | Owner |
|---|---|
| `src/config.ts`, `src/core/types.ts`, `src/core/result.ts`, `src/core/annotations.ts`, interfaces in `src/core/workspace.ts`, `src/core/activity.ts`, `src/skills/registry.ts`, `src/commands/registry.ts`, this file | orchestrator (read-only for agents; ask in your report if a change is needed) |
| `src/index.ts`, `src/http/**`, `src/mcp/**`, `src/admin/**`, `src/core/settings.ts`, implementations in `src/core/workspace.ts`/`activity.ts` | **agy1** core |
| `src/tools/**`, `src/skills/**` (impl files), `src/commands/**` (impl files), `skills/**`, `commands/**`, `test/**` | **agy2** tools |
| `web/**` | **codex1** UI |
| `Dockerfile`, `compose*.yaml`, `.dockerignore`, `.env.example`, `scripts/**`, `README.md`, `docs/SETUP*.md`, `.github/**` | **codex2** infra/docs |

## MCP server (agy1)
- Streamable HTTP via `@modelcontextprotocol/sdk` at `POST|GET|DELETE /mcp` (and `/mcp/<MCP_TOKEN>`), stateful sessions keyed by `Mcp-Session-Id`, with **transparent recovery**: an unknown/stale session id (server restart) is re-created instead of 404, and requests without a session that aren't `initialize` are served by a fresh session. Idle sessions expire after 1h.
- Auth (`AUTH_MODE`): token = `Authorization: Bearer <MCP_TOKEN>` or URL path `/mcp/<MCP_TOKEN>`; oauth = OAuth 2.1 authorization-code + PKCE with **Dynamic Client Registration** (`/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource`, `/oauth/register`, `/oauth/authorize`, `/oauth/token`). The authorize page is a tiny form asking for the access key (= MCP_TOKEN) once; it then issues long-lived tokens (persisted in `DATA_DIR/oauth.json`). Gemini custom apps need OAuth+DCR; ChatGPT works with either. Unauthenticated `/mcp` returns 401 with `WWW-Authenticate: Bearer resource_metadata=...` only when oauth is enabled, otherwise 404.
- `src/mcp/server.ts`: `createMcpServer(ctx)` imports every module in `src/tools/index.ts` (array of ToolModule, owned by agy2), filters by `TOOL_PROFILE` + disabled tools from settings, registers each with `annotationsFor(risk)`, `outputSchema: RESULT_OUTPUT_SCHEMA`, wraps handler with try/catch → `fail()`, activity logging, and `toCallToolResult()`. Also registers every command as an MCP prompt and each enabled skill as an MCP resource `skill://<name>`.
- `src/mcp/instructions.ts`: short server instructions (< 4 KB): what the server is, active workspace, AGENTS.md/CLAUDE.md of active workspace (first 8 KB), list of skill names+descriptions, list of command names, 6-line workflow cheat-sheet.
- `src/core/settings.ts`: persisted `DATA_DIR/settings.json` `{ disabledTools: string[], disabledSkills: string[], approvalMode?, toolProfile? }` with `getSettings()`, `updateSettings(patch)`; settings override env.

## Tools (agy2) — `src/tools/index.ts` default-exports `ToolModule[]`
Essential profile (all others are `full` only). Names are final:
| tool | risk | purpose |
|---|---|---|
| `workspace_info` | read | active root, roots, git branch/status summary, detected stack + package scripts, AGENTS.md/CLAUDE.md |
| `workspace_switch` | read | switch active project root (counts as read: changes no files) |
| `read` | read | read 1..N files (`paths[]`, optional `offset`/`limit` lines), numbered lines, size cap |
| `list` | read | directory tree with depth, ignores node_modules/.git/dist |
| `search` | read | ripgrep content search (regex, glob filter, context lines) **and** `files` mode glob |
| `checkpoints` | read | list recent file modification checkpoints created by `edit_files` |
| `edit_files` | write | batch write, replace, patch, move, copy, delete, mkdir, or undo; creates checkpoint and runs diagnostics |
| `run` | exec | run shell command in bash (cwd, timeout), stop job via `stop_job_id`, or run checks via `verify: true` |
| `job` | read | `status`/`output`/`list` of background jobs |
| `git` | read | read-only git: status, diff (staged/unstaged/path), log, show, branch list, blame |
| `git_write` | exec | add, commit, checkout/switch, branch create, restore, stash, pull, push, merge |
| `skills_list` | read | list enabled skills (name, description, source) |
| `skill_load` | read | return SKILL.md body + file list; `file` param reads a referenced file |
| `skill_save` | write | create/update a user skill from chat (name, description, body, files) |
| `commands_list` | read | list commands |
| `command_run` | read | render a command with args → instructions the model must follow next |
| `fetch_url` | read | HTTP GET a URL (docs, APIs) → text/markdown-ish, size capped |
| `status` | read | server version, uptime, auth mode, tool profile, approval mode |
| `todo` | read | keep a task plan in assistant scratch memory across reconnects (list, set, update) |
| `resume` | read | resume ongoing work: workspace, todo plan, recent activity, git status, running jobs |
| `browser_check` | read | headless browser verification (URL or local HTML): console logs, page errors, screenshot |

Built-in skills in `skills/`: `herdr`, `ui-design`, `code-review`, `git-workflow`, `skill-authoring`.
Built-in commands in `commands/`: `review`, `test`, `fix`, `commit`, `explain`, `plan`, `scaffold`, `docs`, `refactor`, `deps`.

## Admin REST API on :8788 (agy1 implements, codex1 consumes) — JSON, prefix `/api`
Static UI served from `web/` at `/`. No auth (bound to host loopback), but reject requests whose `Host` header isn't localhost/127.0.0.1 (DNS-rebinding guard).
| method & path | response / body |
|---|---|
| `GET /api/status` | `{ version, uptimeSec, authMode, toolProfile, approvalMode, sessions, workspaceRoots, defaultWorkspace, endpoints: { local, public, mcpUrlWithToken, oauthIssuer } }` (`mcpUrlWithToken` = `<public or local>/mcp/<token>`) |
| `GET /api/health` | `{ ok, version, uptime, mcpReachable }` (proxies MCP `/health`) |
| `GET /api/connect` | `{ clients: ClientConnectInfo[], chatgpt: { url, steps }, gemini: { url, steps }, token }` (client connection info and snippets for ChatGPT, Gemini, Claude, Claude Code, Cursor, VS Code, Gemini CLI, Codex CLI, and generic MCP clients) |
| `POST /api/token/rotate` | `{ token }` (persist to DATA_DIR/token, invalidates OAuth tokens) |
| `GET /api/tools` | `[{ name, title, description, group, risk, enabled, profile: "essential"|"full" }]` |
| `PATCH /api/tools/:name` | body `{ enabled }` |
| `GET /api/skills` | `SkillSummary[]` (includeDisabled) |
| `GET /api/skills/:name` | `Skill` |
| `POST /api/skills` | body `SkillInput` → `SkillSummary` |
| `POST /api/skills/import` | body `{ markdown, files? }` or `{ path }` → `SkillSummary` |
| `PATCH /api/skills/:name` | body `{ enabled }` |
| `DELETE /api/skills/:name` | 204 |
| `GET /api/commands` / `GET /api/commands/:name` / `POST /api/commands` / `DELETE /api/commands/:name` | `CommandSummary[]` / `Command` / body `{name,description,args?,template}` / 204 |
| `GET /api/settings` / `PATCH /api/settings` | settings object |
| `GET /api/activity?limit=100` | `ActivityEntry[]` |
| `GET /api/activity/stream` | SSE, `data: ActivityEntry` per event |
Errors: `{ error: string }` with 4xx/5xx.

## Environment (codex2 documents in .env.example; parsed only in src/config.ts)
`PORT=8787 ADMIN_PORT=8788 HOST ADMIN_HOST MCP_TOKEN PUBLIC_URL AUTH_MODE=both WORKSPACE_ROOTS DEFAULT_WORKSPACE DATA_DIR BUILTIN_SKILLS_DIR USER_SKILLS_DIR EXTRA_SKILLS_DIRS BUILTIN_COMMANDS_DIR USER_COMMANDS_DIR APPROVAL_MODE=minimal TOOL_PROFILE=essential SHELL_TIMEOUT_MS SHELL_SYNC_MS MAX_OUTPUT_BYTES CHECKPOINTS LOG_LEVEL`.
If `MCP_TOKEN` is empty at startup, generate one and persist it in `DATA_DIR/token` (agy1).

## Quality bar
`npm run typecheck` and `npm test` green; no new runtime deps beyond package.json without saying why; Node built-ins (`node:test`) for tests.

## Phase 1 additions (see docs/UPGRADE-PLAN.md)
- `ToolContext.callTool(name, args)` / `callableTools()` — server-provided (agy1); used by `exec` (agy2). Inner calls are logged with `via: "exec"` in `ActivityEntry`.
- New tool `exec` (risk exec, group system): run a short JS program in a `node:worker_threads` isolate that calls `await tools.<name>(args)` and emits `text()`/`image()`.
- `run` gains `cmds[]` (≤ 20, one shell, labeled sections + per-item exit codes) and job `stdin`/`poll`.
- `read` gains globs, directory listing (1 level), 256 KB/file and 512 KB/call caps.

## Phase 2 additions — human in the loop + proven finish
Shared store `src/core/board.ts` (orchestrator): `createBoard(DATA_DIR)` → `Board` (requests, finish reports, plan events, `subscribe`). One instance per process, created in `src/index.ts`, passed to the admin app and set as `ToolContext.board` for every session.
- Tools (agy2): `ask_user` (risk read — it runs nothing), `user_request_status` (read; per request: status, note, and for each expected file exists/size/mtime, never the content), `finish` (read; collects evidence: last `run verify:true` and last `browser_check` from activity for this workspace, git diff stats, open requests → `verified` + `warnings`). `todo` calls `ctx.board?.emitPlan(...)` after each change. `resume` lists open requests and the last finish.
- Admin API (agy1): `GET /api/requests?status=&workspace=` → `UserRequest[]`; `POST /api/requests/:id` body `{ status: "done"|"skipped", note? }` → `UserRequest`; `GET /api/finishes?limit=` → `FinishReport[]`; `GET /api/plan?workspace=` → `{ workspace, todos, updatedAt }` (default active/last workspace); `GET /api/board/stream` SSE, `data: BoardEvent`. `/api/status` adds `openRequests`.
- UI (codex1): open requests as cards (command in full, Copy, Mark done, Skip, note), a live Plan panel, Finish cards with evidence + verified/unverified badge, nav badge with open request count.
