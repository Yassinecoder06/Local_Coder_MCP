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

## Quick start

1. Clone the repository:

   ```sh
   git clone https://github.com/Yassinecoder06/Local_Coder_MCP.git && cd Local_Coder_MCP
   ```

2. Run `./scripts/setup.sh` (or `./scripts/setup.sh --yes` to accept defaults). Docker Compose v2 is required.
3. Open [http://localhost:8788](http://localhost:8788) and copy the connection URL and access key shown on the admin **Connect** page.
4. Connect any compatible client using the endpoint and access key on the admin **Connect** page. Remote clients need a public HTTPS URL; see [Getting a public HTTPS URL](#getting-a-public-https-url).

Your project directory defaults to `~/Projects`. It is mounted at the same absolute path inside the container, so file paths stay identical. Change it in `.env` and restart with `docker compose up -d`.

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

## Herdr integration

When setup finds the Herdr CLI and its live socket, it enables the host-tools Compose override automatically and prints `herdr integration: enabled`. The override mounts the CLI and Herdr config directory, sets the Herdr environment, and makes the `herdr` skill available. Otherwise it prints `herdr integration: disabled`; install/start Herdr and run setup again to enable it. Set `HERDR_BIN` in `.env` if the CLI is installed outside the detected path.

This lets a connected AI client use the `herdr` skill to inspect and drive real host terminals and CLI agents. Herdr can send commands and input to those terminals, so protect the Local Coder access key and only connect clients you trust.

## Verification

After edits, inspect diagnostics and run the project's checks so the model can report evidence that the change works. Use `/verify` to identify and run relevant checks; for UI changes, open the running page with `browser_check` and inspect its screenshot. Use `/todo` to keep a concrete checklist for multi-step work and `/resume` to continue from unfinished items later.

## Tools

| Tool | What it does |
|---|---|
| `workspace_info`, `workspace_switch` | Inspect or switch the active workspace |
| `read`, `list`, `search` | Read files, browse directories, and search content or paths |
| `checkpoints` | List recent file change checkpoints |
| `edit_files` | Batch file writing, replacement, patching, moving, copying, deletion, directory creation, and undo |
| `run`, `job` | Run shell commands, inspect background jobs, or stop a job with `stop_job_id` |
| `browser_check` | Open a page in headless Chromium and return a screenshot |
| `git`, `git_write` | Inspect git state; add, commit, branch, stash, and other write operations |
| `skills_list`, `skill_load`, `skill_save` | Find, load, and create skills |
| `commands_list`, `command_run` | Browse and render command prompts |
| `fetch_url`, `status` | Fetch a URL or inspect server status |

The default `TOOL_PROFILE=essential` is tuned for web chat. Set `TOOL_PROFILE=full` in `.env` to expose additional tools as they are available.

## Configuration

Values are set in `.env`. Compose binds both ports to loopback and mounts `/data` for persistent state.

| Variable | Default | Purpose |
|---|---:|---|
| `PROJECTS_DIR` | `~/Projects` | Host directory mounted at the same path; Compose sets `WORKSPACE_ROOTS` to it |
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

## License

MIT. See [LICENSE](LICENSE).
