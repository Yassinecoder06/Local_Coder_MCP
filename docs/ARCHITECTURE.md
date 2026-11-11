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
| `todo` | read | keep a task plan in assistant scratch memory across reconnects (list, set, update, clear) |
| `resume` | read | resume ongoing work: workspace, todo plan, recent activity, git status, running jobs |
| `browser_check` | read | headless browser verification (URL or local HTML): console logs, page errors, screenshot |

Built-in skills in `skills/`: `herdr`, `herdr-web`, `ui-design`, `code-review`, `git-workflow`, `skill-authoring`, `docker-dev`.
Built-in commands in `commands/`: `review`, `test`, `fix`, `commit`, `explain`, `plan`, `scaffold`, `docs`, `refactor`, `deps`.

## Admin REST API on :8788 (agy1 implements, codex1 consumes) — JSON, prefix `/api`
Static UI served from `web/` at `/`. No auth (bound to host loopback), but reject requests whose `Host` header isn't localhost/127.0.0.1 (DNS-rebinding guard).
| method & path | response / body |
|---|---|
| `GET /api/status` | `{ version, uptimeSec, authMode, toolProfile, approvalMode, sessions, workspaceRoots, defaultWorkspace, workspaceSource, mountDirs, endpoints: { local, public, mcpUrlWithToken, pluginsUrlWithToken, oauthIssuer } }` (`mcpUrlWithToken` = `<public or local>/mcp/<token>`) |
| `GET /api/health` | `{ ok, version, uptime, mcpReachable }` (proxies MCP `/health`) |
| `GET /api/connect` | `{ clients: ClientConnectInfo[], chatgpt: { url, steps }, gemini: { url, steps }, plugins: { url }, token }` (client connection info and snippets for ChatGPT, Gemini, Claude, Claude Code, Cursor, VS Code, Gemini CLI, Codex CLI, and generic MCP clients) |
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
| `GET /api/plans` | non-empty saved plans for existing workspaces, newest first |
| `GET /api/plan?workspace=` | one workspace's plan; defaults to the latest plan or active workspace |
| `GET /api/plugins` | `PluginSummary[]` |
| `GET /api/plugins/recipes` | `PluginRecipe[]` |
| `POST /api/plugins/import/preview` | body `{ text }` → `{ plugins, warnings }`; parses only and never starts/saves a plugin |
| `POST /api/plugins` | body `PluginInput` → `PluginSummary` |
| `GET /api/plugins/:id` | `PluginDetail` |
| `PATCH /api/plugins/:id` | body `Partial<PluginInput> & { enabled? }` → `PluginSummary` |
| `DELETE /api/plugins/:id` | 204 |
| `POST /api/plugins/:id/restart` | `PluginSummary` |
| `PATCH /api/plugins/:id/tools/:tool` | body `{ enabled }` → `PluginTool` |
| `PUT /api/workspaces` | body `{ roots: string[], defaultWorkspace?: string }` → `{ roots, defaultWorkspace, source }` |
| `DELETE /api/workspaces` | `{ roots, defaultWorkspace, source }` (resets to env) |
| `GET /api/fs/dirs?path=` | `{ path, parent?, dirs: { name, path, isGitRepo }[] }` |
Errors: `{ error: string }` with 4xx/5xx.

## Result truncation

MCP response text is capped by `MAX_OUTPUT_BYTES`. When a result exceeds the cap, the server keeps its head and tail with a `bytes omitted` marker so clients retain both the start and end. Use `job` output or `read` with line ranges to inspect the omitted middle.

## Skill sources and shadowing

Skills resolve by name in source priority order: user skills, active-workspace skills, `EXTRA_SKILLS_DIRS`, then built-ins. The first matching name wins. `skills_list` reports the selected source, making a host skill mounted through `EXTRA_SKILLS_DIRS` visible when it shadows a built-in. The built-in Herdr web-chat playbook is named `herdr-web` to avoid colliding with a host `herdr` skill.

## Persisted workspace state janitor

Startup cleanup removes stale references to deleted workspace folders from persisted workspace settings and checkpoint/plan state. The Admin `GET /api/plans` endpoint also filters plans whose workspace folder no longer exists. Clear a plan explicitly with `todo` action `clear` or **Admin → Requests → Clear plan**.

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

## Phase 3 additions — plugins hub
Contract: `src/core/plugins.ts` (orchestrator). External MCP servers are republished on a **separate** endpoint so the core tool list stays small.
- Endpoint (agy1): `POST|GET|DELETE /mcp/plugins` and `/mcp/plugins/<MCP_TOKEN>`, same auth (token/OAuth) and session recovery as `/mcp`. Its MCP server lists `hub.publishedTools()` with upstream names, descriptions, input schemas; annotations passed through unchanged (or read-only when the plugin is `trusted`); calls go to `hub.callTool()` and the upstream result is returned as-is; activity logged with `client` as usual and `tool` = `<plugin>/<name>`. Sends `tools/list_changed` when the hub changes. Server instructions: one short paragraph listing plugin names.
- Hub (agy1, `src/plugins/hub.ts`): uses `@modelcontextprotocol/sdk` Client with `StdioClientTransport` (command + args, no shell; env merged over a minimal safe env incl. PATH/HOME and cache dirs) or `StreamableHTTPClientTransport` (https or loopback http only). Config in `DATA_DIR/plugins.json` (0600). Ready only after `listTools` succeeds. Publication capped by `PLUGIN_LIMITS`; names declared by two plugins are excluded from both (`reason: "conflict"`). Never retries calls. Crash → state `error` with the first useful stderr line; no automatic restart loop (one retry on start is fine).
- Admin API (agy1), JSON, secrets always masked (`MASKED`):
  `GET /api/plugins` → `PluginSummary[]` · `GET /api/plugins/recipes` → `PluginRecipe[]` · `POST /api/plugins` body `PluginInput` → `PluginSummary` · `GET /api/plugins/:id` → `PluginDetail` · `PATCH /api/plugins/:id` body `Partial<PluginInput> & {enabled?}` · `DELETE /api/plugins/:id` → 204 · `POST /api/plugins/:id/restart` → `PluginSummary` · `PATCH /api/plugins/:id/tools/:tool` body `{enabled}` → `PluginTool`. `/api/status.endpoints` adds `pluginsUrlWithToken`; `/api/connect` adds `plugins: { url }`.
- Recipes (agy2): `plugins/recipes.json` (pinned versions) loaded/validated by `src/plugins/recipes.ts` (`loadRecipes(): Promise<PluginRecipe[]>`, `recipeToInput(recipe, secrets: Record<string,string>): PluginInput`). Built-in dir `BUILTIN_PLUGINS_DIR` default `./plugins` (`/app/plugins` in Docker).
- UI (codex1): Plugins page. Docker/docs/e2e (codex2): `uv` in the image, npm/uv caches under `/data/cache`, README section.

## Plugins through the main connector

`ToolContext.plugins` implements `PluginBridge` for ready plugins and enabled tools. The read-only `plugin_tools` core tool lists the available bridge tools. Code mode exposes them as `plugins["<plugin-id>"].<tool>(args)`, so clients can call a plugin through their existing `/mcp` connector without adding `/mcp/plugins` as a second connection. A bridged tool is callable only when it is enabled, its plugin is ready, and either the plugin is trusted or the upstream annotation has `readOnlyHint: true`; plugin trust does not change the annotations published on the separate endpoint.

Both endpoint publication and the main connector use normalized JSON Schemas. Normalization drops unsupported schema keywords (including `$schema`, `$id`, `$comment`, `examples`, conditionals, and `not`), inlines local `$ref` definitions, converts numeric `exclusiveMinimum`/`exclusiveMaximum` to `minimum`/`maximum` plus an explanatory description, simplifies nullable unions, merges object `allOf`, and removes required names without properties. The `PluginTool.adjustments` array records each change and is visible from `GET /api/plugins/:id`.

`POST /api/plugins/import/preview` accepts `{ text }` and returns `{ plugins, warnings }` without starting a server or saving configuration. It recognizes pasted `mcpServers`/`servers` JSON, a single server object, a shell command line, or an MCP URL. Missing or placeholder credentials are reported as `needsSecrets` for the review step.

## Editable workspace roots
Roots are no longer env-only. Effective roots = `settings.workspaceRoots` if set and non-empty, else `WORKSPACE_ROOTS`/`PROJECTS_DIR` from env. Effective default = `settings.defaultWorkspace` (must be inside a root) else env default.
- Docker can only see mounted folders. `MOUNT_DIR` in `.env` (default = `PROJECTS_DIR`) is bind-mounted at the same path; every root must be inside an allowed area: env roots ∪ `MOUNT_DIR` ∪ `ALLOWED_ROOTS` (new optional env, list). A root must exist and be a readable directory when saved.
- `Settings` gains `workspaceRoots?: string[]`, `defaultWorkspace?: string` (agy1, `src/core/settings.ts`). Changes apply live: new sessions use them; existing sessions keep working (their active root stays valid if still inside a root, else falls back to the default). `/api/status` returns effective `workspaceRoots`, `defaultWorkspace`, plus `workspaceSource: "settings"|"env"` and `mountDirs: string[]`.
- Admin API (agy1): `PUT /api/workspaces` body `{ roots: string[], defaultWorkspace?: string }` → `{ roots, defaultWorkspace, source }` (400 with a clear message for a path that is missing, not a dir, or outside the mounted area — say which `.env` line to change). `DELETE /api/workspaces` → back to env. `GET /api/fs/dirs?path=` → `{ path, parent?, dirs: { name, path, isGitRepo }[] }`, only inside allowed areas, hides dot-dirs and node_modules, max 500 entries — for the folder picker.
- UI (codex1): Settings › Workspace roots becomes editable: list with remove + "set default", "Add folder" opens a folder picker (browse from the mount dirs, git repos marked), Save / Reset to .env. Note under it: "Only folders inside <mountDirs> are reachable. To reach others, set MOUNT_DIR in .env and run `make up`."
- Infra (codex2): compose mounts `${MOUNT_DIR:-${PROJECTS_DIR}}` at the same path and passes `MOUNT_DIR`, `ALLOWED_ROOTS`; `.env.example`, setup.sh (ask once, default PROJECTS_DIR), README + SETUP docs; e2e: PUT a new root under the mount, a tool can list it, outside path → 400, DELETE resets.

## Client call budget and workspace state
Web clients may time out around 10 seconds; keep Gemini tool calls below about 8 seconds. Batch independent shell commands into one `run({ cmds: [...] })` call. Active workspace is stored per client, so switching one client's folder does not change another's.

## Persistent services
Start long-running development servers with `run({ service, command, port })`. They are named services managed by the MCP process; use `job` actions to list services, read logs, stop, or restart them. Do not background servers with `nohup` or `&`.
