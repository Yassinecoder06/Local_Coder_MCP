# Local Coder MCP

[![CI](https://github.com/Yassinecoder06/Local_Coder_MCP/actions/workflows/ci.yml/badge.svg)](https://github.com/Yassinecoder06/Local_Coder_MCP/actions/workflows/ci.yml)
![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)

Self-hosted MCP coding tools for your local workspaces, available to any compatible AI client.

**Works with:** ChatGPT, Gemini, Claude, Claude Code, Cursor, VS Code, Codex CLI, Gemini CLI, Le Chat, and other MCP clients.

```text
Any MCP client ─── HTTPS tunnel (optional) ───► MCP :8787
Browser on this machine ──────────────────────► Admin :8788 (loopback only)
                                                   │
                                      Docker ──────┴── /data + mounted projects
```

## What it can do

Local Coder turns any AI chat into a coding agent that works on **your real projects, on your machine**. It doesn't hand you code to paste: it reads, edits, runs, tests and verifies the work itself.

### 🧑‍💻 Real coding agent in any chat
- **Works on your actual files.** Read, search, edit, move and undo across your projects. Every edit makes a checkpoint you can roll back, and diagnostics run right after each change.
- **Runs your terminal.** Builds, tests, installs and dev servers. Long commands keep running in the background, and the model can type into interactive prompts.
- **Uses git properly.** Status, diffs, history and blame, then commit, branch, stash and push.
- **Remembers where it was.** A task plan and `resume` survive reconnects and new chats; say "continue" and it picks up from there.

### ✅ Proves its work instead of claiming it
- **Runs the right checks itself.** `run verify:true` finds and runs the project's checks (typecheck, tests, lint).
- **Tests UIs in a real browser.** `browser_check` opens your app in headless Chromium, clicks and types, collects console errors and failed requests, and sends back a **screenshot** the model can see. With the Playwright plugin it gets a full browser session it can drive step by step.
- **A "done" you can trust.** When the model calls `finish`, the server checks the evidence: a passing check after the last edit, the git changes and no open requests. Each report is marked **Verified** or **Not verified**, with the reasons.

### ⚡ Built for the limits of web chats
- **One call does the work of many.** `exec` runs a small JavaScript program that calls the other tools in parallel (up to 32 calls in one approval). `run` takes up to 20 commands in one shell, and `read` takes many files and folders at once. This keeps web chats under their tool-calls-per-reply cap.
- **Few or no approval prompts.** Read-only tools never ask. In Minimal mode only 4 tools ask, once each, and Trust mode never asks. You can switch modes live.
- **Survives restarts.** Stale sessions recover on their own, so a server restart doesn't break the chat.

### 🤝 You stay in control
- **The model can ask you for a step.** For sudo, logins, secrets or hardware it posts the exact command as a card on **Admin → Requests**, with **Copy / Mark done / Skip**. It never runs those commands itself, and it can check that the files it expected now exist.
- **A live plan.** See the model's current task list update as it works.
- **Activity log.** Every tool call, from every client, appears live in the admin UI, including the calls made inside `exec`.

### 🧩 Extend it in minutes
- **Skills:** drop a folder with a `SKILL.md` in it, import it in the UI, or ask the chat to save one. Built-ins: herdr, UI design, code review, git workflow, Docker dev, skill authoring.
- **Commands:** reusable task recipes such as `/review`, `/fix`, `/test`, `/ship`, `/verify` and `/delegate`. They show up as slash commands where the client supports them, and as `command_run` everywhere else.
- **Plugins hub:** plug in other MCP servers (Playwright, Fetch, Memory, GitHub or your own) from the **Plugins** page. Their tools are served on a second address, so your main tool list stays small. Each tool can be switched on or off, and secrets are masked.
- **Agent teams with herdr:** drive real terminal agents (Claude Code, Codex, Gemini CLI and others) on your machine. Hand a task to an agent and get its report back in one call.

### 🔒 Safe by default, easy to run
- **Runs in Docker** as your user. Projects are mounted at the same paths, and you pick which folders are reachable from **Settings → Workspace roots**, with a folder browser.
- **Locked down by default:**
  - A secret access key, with OAuth 2.1 + PKCE login for web apps.
  - The admin UI is local-only, with a DNS-rebinding guard.
  - Every path is checked against the allowed folders, including through symlinks.
- **Any client, one setup:** ChatGPT, Gemini, Claude, Claude Code, Cursor, VS Code, Codex CLI, Gemini CLI and Le Chat all use the same server and the same key. The admin **Connect** page shows the exact steps for each.

## Quick start

1. Clone the repository:

   ```sh
   git clone https://github.com/Yassinecoder06/Local_Coder_MCP.git && cd Local_Coder_MCP
   ```

2. Run `./scripts/setup.sh` (or `./scripts/setup.sh --yes` to accept defaults). Docker Compose v2 is required.
3. Open [http://localhost:8788](http://localhost:8788) and copy the connection URL and access key shown on the admin **Connect** page.
4. Connect any compatible client using the endpoint and access key on the admin **Connect** page. Remote clients need a public HTTPS URL; see [Getting a public HTTPS URL](#getting-a-public-https-url).

Your project directory defaults to `~/Projects`. It is mounted at the same absolute path inside the container, so file paths stay identical. Change which folders the server uses any time in **Admin → Settings → Workspace roots** (see below).

## Change project folders

Use **Admin → Settings → Workspace roots** to add, remove, or choose the default project folder; the change applies to new sessions immediately. Folders must exist inside a mounted area. To make a wider host area available, set `MOUNT_DIR` in `.env` and run `make up`; it defaults to `PROJECTS_DIR`. The container can read and write everything under `MOUNT_DIR`, so choose a folder you are comfortable exposing to connected clients. `ALLOWED_ROOTS` can add extra allowed paths, but those paths must also be mounted into Docker.

## Connect your client

Use the MCP URL shown on the admin **Connect** page, normally `<base>/mcp`, and the access key shown there. Choose OAuth and sign in with the access key, or configure the client to send `Authorization: Bearer <key>`. Some clients support the URL form `<base>/mcp/<key>` instead. Remote clients must be able to reach the server over HTTPS; see [Getting a public HTTPS URL](#getting-a-public-https-url). Client menus, plan availability, and configuration formats can change; use the linked client documentation for current details.

| Client | Connection steps |
|---|---|
| **ChatGPT web** | Open **Settings → Apps & Connectors → Advanced → Developer mode → Create** and enter `<base>/mcp`. Choose OAuth and sign in with the access key, or choose no auth and use `<base>/mcp/<key>`. See [OpenAI's guide](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt). |
| **Gemini web** | Open **Settings → Connected apps → Add custom app** and enter `<base>/mcp`. Leave Client ID and secret empty, then sign in with the access key. See [Google's guide](https://support.google.com/gemini/answer/17209137). |
| **Claude.ai / Claude Desktop** | Open **Settings → Connectors → Add custom connector**, enter `<base>/mcp`, then complete OAuth sign-in with the access key. See [Anthropic's guide](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp). |
| **Claude Code** | Run `claude mcp add --transport http local-coder <base>/mcp --header "Authorization: Bearer <key>"`. See [Claude Code MCP docs](https://code.claude.com/docs/en/mcp). |
| **Cursor** | Add this entry to `~/.cursor/mcp.json`: `{"mcpServers":{"local-coder":{"url":"<base>/mcp","headers":{"Authorization":"Bearer <key>"}}}}`. See [Cursor MCP docs](https://docs.cursor.com/context/model-context-protocol). |
| **VS Code** | Add this entry to `.vscode/mcp.json`: `{"servers":{"local-coder":{"type":"http","url":"<base>/mcp","headers":{"Authorization":"Bearer <key>"}}}}`. See [VS Code MCP docs](https://code.visualstudio.com/docs/agent-customization/mcp-servers). |
| **Gemini CLI** | Add to `~/.gemini/settings.json`: `{"mcpServers":{"local-coder":{"httpUrl":"<base>/mcp","headers":{"Authorization":"Bearer <key>"}}}}`. See [Gemini CLI MCP docs](https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md). |
| **Codex CLI** | Add `[mcp_servers.local-coder]` and `url = "<base>/mcp"`, `bearer_token_env_var = "LOCAL_CODER_TOKEN"` to `~/.codex/config.toml`, then `export LOCAL_CODER_TOKEN=<key>`. See [Codex MCP docs](https://learn.chatgpt.com/docs/extend/mcp?surface=cli). |
| **Le Chat and other MCP clients** | For any client that supports remote Streamable HTTP MCP, configure `<base>/mcp` with `Authorization: Bearer <key>`, or use OAuth discovery and sign in with the access key. Follow the client's MCP setup documentation. |

## Getting a public HTTPS URL

Web clients cannot reach `localhost`. Start an ephemeral Cloudflare Quick Tunnel:

```sh
docker compose --profile tunnel up -d
```

The server discovers the Quick Tunnel URL automatically from Cloudflare's tunnel metrics endpoint. It appears in the admin UI once the tunnel is up; no manual `PUBLIC_URL` setting is needed. Quick Tunnel URLs change when the tunnel is recreated. For a stable hostname, create a Cloudflare named tunnel, put its token in `CLOUDFLARE_TUNNEL_TOKEN`, then start it with `docker compose --profile named-tunnel up -d named-tunnel` and set `PUBLIC_URL` to its configured hostname. Tailscale Funnel and ngrok are alternatives; point either at the MCP port `8787` and set `PUBLIC_URL` to its HTTPS URL.

### Already have your own domain or Cloudflare tunnel?

Point your existing tunnel or reverse proxy at the host port set by `PORT` in `.env`. For example, `PORT=3000` publishes host port `3000` and passes `HOST_PORT=3000` to the server. Set `PUBLIC_URL=https://your-domain`. You do not need the `tunnel` profile. The server always listens on port `8787` inside the container; `PORT` only selects the host port that Compose publishes. For a tunnel running in a separate container on this Compose network, target `http://mcp:8787` instead.

The admin port remains bound to `127.0.0.1` and is never sent through the tunnel.

## Fewer permission prompts

Choose an approval mode in `.env` or switch it live in **Admin → Settings**:

- **Trust** never asks for confirmation. It marks every tool as read-only to the client. Use this only if you trust the prompts and content in your workspace: text the AI reads could instruct it to run commands without asking.
- **Minimal** is the default. Read-only tools never ask. Only four tools ask once each: `edit_files`, `run`, `git_write`, and `skill_save`. In clients with per-tool approval controls, click **Always allow** once per tool.
- **Standard** uses conservative annotations, so clients may ask for confirmation each time a mutating or command tool runs.

## Skills

Add skills in `data/skills/`, import them in the admin UI, or ask the chat to use `skill_save`. A skill is a folder containing `SKILL.md`:

```markdown
---
name: release-check
description: Check a project before release.
---

Inspect the working tree, run the project's checks, and summarize any release blockers.
```

Built-in skills: `herdr`, `ui-design`, `code-review`, `git-workflow`, `skill-authoring`, and `docker-dev`. Setup mounts host skills when it detects a usable Herdr integration (see [Docker setup](docs/SETUP-Docker.md)).

## Commands

Built-ins: `/review`, `/test`, `/fix`, `/commit`, `/explain`, `/plan`, `/scaffold`, `/docs`, `/refactor`, `/deps`, `/delegate`, `/onboard`, `/ship`, `/verify`, `/todo`, and `/resume`. Add user commands in `data/commands/` or through the admin UI; each command is a Markdown file with a name, description, optional arguments, and prompt template.

## Plugins

Plugins connect external MCP servers and publish their tools through your existing main connector, including Gemini; the separate `<base>/mcp/plugins/<token>` endpoint is also available. In **Admin → Plugins**, paste any MCP config/command for a preview, or choose a pinned recipe. The Chrome DevTools recipe provides Lighthouse, performance, console, and network tools. Most of its tools need a `pageId` from `list_pages`; for the current page use Lighthouse snapshot mode:

```js
const result = await plugins["chrome-devtools"].lighthouse_audit({ pageId: 2, mode: "snapshot" });
text(result.summary);
```

The **Trusted** switch permits non-read-only tools through `exec`; without it, only upstream read-only tools are callable from the main connector. Secrets are masked in the admin API. Publication is capped at 256 tools and 250 KB of schemas, with 60 seconds to start, 120 seconds per call, and 2 MiB per result.

## Herdr integration

When setup finds the Herdr CLI and its live socket, it enables the host-tools Compose override automatically and prints `herdr integration: enabled`. The override mounts the CLI and Herdr config directory, sets the Herdr environment, and makes the `herdr` skill available. Otherwise it prints `herdr integration: disabled`; install/start Herdr and run setup again to enable it. Set `HERDR_BIN` in `.env` if the CLI is installed outside the detected path.

This lets a connected AI client use the `herdr` skill to inspect and drive real host terminals and CLI agents. Herdr can send commands and input to those terminals, so protect the Local Coder access key and only connect clients you trust.

## Verification

After edits, inspect diagnostics and run the project's checks so the model can report evidence that the change works. Use `/verify` to identify and run relevant checks; for UI changes, open the running page with `browser_check` and inspect its screenshot. Use `/todo` to keep a concrete checklist for multi-step work and `/resume` to continue from unfinished items later.

## Fewer tool calls

Web chats cap how many tools the model can call per reply, so Local Coder lets one call do more:

- **`exec`** runs a short JavaScript program that calls other tools: `const [a, b] = await Promise.all([tools.read({paths: ["package.json"]}), tools.git({subcommand: "status"})]); text(a.summary);` (up to 32 calls, 8 at a time, 60 s; only what you pass to `text()`/`image()` comes back).
- **`run` with `cmds`** executes up to 20 commands in one Bash session; `cd` and environment changes carry over, and each command reports its own exit code (`stop_on_error` is optional).
- **`job` with `stdin` and `poll`** drives interactive background commands.
- **`read`** takes many `paths` at once, expands globs, lists directories, and returns up to 256 KB per file.

If a client still hits its cap, say "continue": the model calls `resume` and carries on.

## Working with the model

If the model needs you to run a command, it posts a request card on **Admin → Requests** (the sidebar badge shows how many are open). Use **Copy** to run the exact command in its stated folder, then choose **Mark done** or **Skip**; the server never runs it for you. The model can check your response with `user_request_status`. The same page shows a live Plan panel with its current todo list, and the reports from `finish` with their evidence. **Verified** means the server found a passing `verify` or `browser_check` and no open requests; otherwise the report includes warnings.

## Tools

| Tool | What it does |
|---|---|
| `workspace_info`, `workspace_switch` | Inspect or switch the active project |
| `read`, `list`, `search` | Read many files at once (globs, directories), browse, and search content or paths |
| `edit_files`, `checkpoints` | Batch write, replace, patch, move, copy, delete and undo, with diagnostics after each edit; list checkpoints |
| `run`, `job` | Run shell commands or batches (`cmds`), checks (`verify: true`), background jobs with `stdin`/`poll` |
| `exec` | Run a JavaScript program that calls other tools in parallel: many steps in one call |
| `browser_check` | Open a page in headless Chromium, interact, collect console errors and return a screenshot |
| `git`, `git_write` | Inspect git state; add, commit, branch, stash, pull, push and merge |
| `ask_user`, `user_request_status` | Hand you one exact step (shown as a card) and check whether it's done |
| `finish` | Report the task as done; the server checks the evidence and marks it Verified or not |
| `todo`, `resume` | Keep a task plan and pick up unfinished work after a reconnect |
| `skills_list`, `skill_load`, `skill_save` | Find, load and create skills |
| `commands_list`, `command_run` | Browse and render command recipes |
| `fetch_url`, `status` | Fetch a URL or inspect server status |

Plugin tools (Playwright, Fetch, Memory, GitHub, your own servers) are served on the separate plugins endpoint.

The default `TOOL_PROFILE=essential` is tuned for web chat. Set `TOOL_PROFILE=full` in `.env` to expose additional tools as they are available.

## Configuration

Values are set in `.env`. Compose binds both ports to loopback and mounts `/data` for persistent state.

| Variable | Default | Purpose |
|---|---:|---|
| `PROJECTS_DIR` | `~/Projects` | Host directory mounted at the same path; Compose sets `WORKSPACE_ROOTS` to it |
| `MOUNT_DIR` | `PROJECTS_DIR` | Host directory mounted at the same path; all descendants are accessible to the container |
| `ALLOWED_ROOTS` | empty | Additional workspace root areas; mount these paths into Docker as well |
| `HOST_UID`, `HOST_GID` | current host IDs | Run the container as the host user for mounted files |
| `PORT`, `ADMIN_PORT` | `8787`, `8788` | Host ports published for MCP and admin; the MCP server listens on `8787` inside Docker |
| `MCP_TOKEN` | generated by setup | Access key for token auth and OAuth login |
| `PUBLIC_URL` | empty | HTTPS base URL used by OAuth and web clients |
| `TUNNEL_METRICS_URL` | `http://tunnel:2000` in Compose | Cloudflare Quick Tunnel URL discovery; Compose supplies this automatically |
| `CHROMIUM_PATH` | `/usr/local/bin/chromium` in Docker | Chromium wrapper used by the read-only screenshot check |
| `AUTH_MODE` | `both` | `token`, `oauth`, `both`, or `none` (local use only) |
| `APPROVAL_MODE` | `minimal` | `trust`, `minimal`, or `standard`; can also be changed live in Admin → Settings |
| `TOOL_PROFILE` | `essential` | `essential` or `full` tool set |
| `DATA_DIR` | `/data` in Docker | Persistent server data, skills, and commands |
| `DEFAULT_WORKSPACE` | first workspace root | Initial active project |
| `SHELL_TIMEOUT_MS`, `SHELL_SYNC_MS` | `120000`, `15000` | Shell command limit and foreground wait window |
| `MAX_OUTPUT_BYTES` | `60000` | Maximum tool output size |
| `CHECKPOINTS` | `true` | Save checkpoints for tool-driven edits |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, or `error` logging |
| `BUILTIN_SKILLS_DIR`, `USER_SKILLS_DIR`, `EXTRA_SKILLS_DIRS` | app and `/data` paths | Skill sources; extra paths are comma- or semicolon-separated |
| `BUILTIN_COMMANDS_DIR`, `USER_COMMANDS_DIR` | app and `/data` paths | Built-in and user command locations |
| `CLOUDFLARE_TUNNEL_TOKEN` | empty | Optional token for a stable Cloudflare named tunnel |

`HOST`, `ADMIN_HOST`, and `WORKSPACE_ROOTS` are also supported by the app. Docker sets the listener hosts to `0.0.0.0` internally and derives workspace roots from `PROJECTS_DIR`.

## Run without Docker

With Node.js 22 or later:

```sh
npm ci
npm run build
npm start
```

Set `WORKSPACE_ROOTS`, `MCP_TOKEN`, and `DATA_DIR` in your environment as needed. The admin listener defaults to loopback; keep it local or protect it with your own network controls.

## Security

The server can read and change files and run shell commands in mounted workspaces. Connect only to a server you control, use a strong access key, review tool actions, and keep the admin port local. For internet access, expose only the MCP port through a trusted HTTPS tunnel. Avoid `AUTH_MODE=none` except for isolated local testing.

## Troubleshooting

- **Docker says `PROJECTS_DIR` is missing:** run `./scripts/setup.sh` or set an absolute `PROJECTS_DIR` in `.env`.
- **Admin page does not load:** check `docker compose ps` and `docker compose logs mcp`; use `http://localhost:8788` on the Docker host.
- **Client cannot connect:** web clients need an HTTPS tunnel; Quick Tunnel URLs appear automatically, while named tunnels and other providers need the matching `PUBLIC_URL`.
- **Files are owned by the wrong user:** confirm `HOST_UID` and `HOST_GID` in `.env` match `id -u` and `id -g`, then recreate the service.
- **Quick Tunnel URL is missing:** wait a few seconds and check `docker compose --profile tunnel logs -f tunnel`.
- **Tool-call limit per turn reached:** this is a client-side cap. Say “continue” to resume, and batch related commands to use fewer calls.
- **Headless Chromium crashed:** use `browser_check` for page verification. Rebuild the Docker image to install the Chromium wrapper for raw headless Chromium commands.
- **A folder is missing from the folder picker:** it is outside `MOUNT_DIR`. Set `MOUNT_DIR` to a parent folder in `.env` and run `make up`.
- **Gemini says check the URL for `/mcp/plugins`:** use the main connector instead; plugin schemas are normalized now.
- **Gemini reports `502` or `DEADLINE_EXCEEDED`:** keep each tool call under about 8 seconds. If the Cloudflare tunnel is flaky, switch its systemd service to HTTP/2:
  ```sh
  sudo systemctl edit cloudflared
  ```
  Add these lines to the override:
  ```ini
  [Service]
  ExecStart=
  ExecStart=/usr/local/bin/cloudflared tunnel --protocol http2 run
  ```
  Then run `sudo systemctl restart cloudflared`.
- **Workspace jumped back:** active workspaces are remembered per MCP client. Switch workspace again in the client whose folder you want to change.
- **Dev server dies:** start it as a named service with `run({ service: "dev", command: "npm run dev", port: 5173 })`; inspect and control it with `job` services/logs/stop/restart actions.

## License

MIT. See [LICENSE](LICENSE).
