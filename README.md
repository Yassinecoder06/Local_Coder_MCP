# Local Coder MCP

Local Coder MCP is a self-hosted MCP server that connects ChatGPT and Gemini web to your local coding workspaces. It provides file, shell, git, skills, and command tools while keeping the admin UI on your machine.

```text
ChatGPT / Gemini ── HTTPS tunnel (optional) ──► MCP :8787
Browser on this machine ──────────────────────► Admin :8788 (loopback only)
                                                   │
                                      Docker ──────┴── /data + mounted projects
```

## Quick start

1. Run `./scripts/setup.sh` (or `./scripts/setup.sh --yes` to accept defaults). Docker Compose v2 is required.
2. Open [http://localhost:8788](http://localhost:8788) and copy the connection URL and access key shown in the admin page.
3. Connect ChatGPT or Gemini using the steps below. The local server is ready for local MCP clients; web clients also need a public HTTPS URL.

Your project directory defaults to `~/Projects`. It is mounted at the same absolute path inside the container, so file paths stay identical. Change it in `.env` and restart with `docker compose up -d`.

## Connect ChatGPT

Custom MCP apps are available on ChatGPT Business and Enterprise/Edu web plans. A workspace admin may need to enable developer mode or grant permission first.

1. In ChatGPT, open **Settings → Apps → Advanced settings** and enable **Developer mode** if available. Business admins can also enable it from **Workspace settings → Apps → Create**; Enterprise/Edu admins manage access under **Workspace settings → Permissions & Roles → Connected Data**.
2. Go to **Settings → Apps → Create** (or **Workspace settings → Apps → Create** if you are an admin) and enter the MCP URL from Local Coder's admin page.
3. Choose the offered authentication method. For OAuth, complete the access-key login; for token authentication, use the token URL from the admin page. Scan the tools and create the app.
4. In a chat, select the new app for a message, then ask it to inspect or edit a project.

See [OpenAI's current setup guide](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt) for plan and workspace details.

## Connect Gemini

Gemini custom apps require an eligible plan/account that offers the feature. Google currently limits availability by account, region, and settings; OAuth with Dynamic Client Registration (DCR) is required for the guided login flow. The access key shown by Local Coder is the OAuth login credential.

1. Open [gemini.google.com](https://gemini.google.com).
2. Click **Settings → Connected Apps**. If it is missing, first open **Personal Intelligence → Connected Apps**.
3. Under **Custom apps**, choose **Add a custom app** (or enter the MCP URL in the add-app field), then paste the MCP URL from the admin page.
4. Click **Next** and complete the OAuth prompt using the Local Coder access key.
5. In a prompt, type `@` and select the custom app to use it.

See [Google's custom app guide](https://support.google.com/gemini/answer/17209137) for current eligibility and availability.

## Getting a public HTTPS URL

Web clients cannot reach `localhost`. Start an ephemeral Cloudflare Quick Tunnel:

```sh
docker compose --profile tunnel up -d tunnel
./scripts/tunnel-url.sh
```

Copy the printed URL into `PUBLIC_URL` in `.env`, then restart the server with `docker compose up -d mcp`. The admin page will then show public connection URLs. Quick Tunnel URLs change when the tunnel is recreated. For a stable hostname, create a Cloudflare named tunnel, put its token in `CLOUDFLARE_TUNNEL_TOKEN`, then start it with `docker compose --profile named-tunnel up -d named-tunnel`; set `PUBLIC_URL` to its configured hostname. Tailscale Funnel and ngrok are alternatives; point either at the MCP port `8787` and set `PUBLIC_URL` to its HTTPS URL.

The admin port remains bound to `127.0.0.1` and is never sent through the tunnel.

## Fewer permission prompts

`APPROVAL_MODE=minimal` is the default. Read-only tools never ask for confirmation; write and execution tools carry risk annotations so the client can decide when to confirm. Use batch tools such as `apply_patch` for related edits. In ChatGPT, choose **Always allow** once per tool when you trust its actions.

## Skills

Add skills in `data/skills/`, import them in the admin UI, or ask the chat to use `skill_save`. A skill is a folder containing `SKILL.md`:

```markdown
---
name: release-check
description: Check a project before release.
---

Inspect the working tree, run the project's checks, and summarize any release blockers.
```

Built-in skills: `herdr`, `ui-design`, `code-review`, `git-workflow`, and `skill-authoring`. Host skills can optionally be mounted with `compose.host-tools.yaml` (see [Docker setup](docs/SETUP-Docker.md)).

## Commands

Built-ins: `/review`, `/test`, `/fix`, `/commit`, `/explain`, `/plan`, `/scaffold`, `/docs`, `/refactor`, and `/deps`. Add user commands in `data/commands/` or through the admin UI; each command is a Markdown file with a name, description, optional arguments, and prompt template.

## Tools

| Tool | What it does |
|---|---|
| `workspace_info`, `workspace_switch` | Inspect or switch the active workspace |
| `read`, `list`, `search` | Read files, browse directories, and search content or paths |
| `write`, `edit`, `apply_patch`, `file_ops`, `undo` | Make checkpointed file changes and restore them |
| `run`, `job`, `job_stop` | Run shell commands and manage background jobs |
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
| `UID`, `GID` | current host IDs | Run the container as the host user for mounted files |
| `PORT`, `ADMIN_PORT` | `8787`, `8788` | MCP and local admin ports |
| `MCP_TOKEN` | generated by setup | Access key for token auth and OAuth login |
| `PUBLIC_URL` | empty | HTTPS base URL used by OAuth and web clients |
| `AUTH_MODE` | `both` | `token`, `oauth`, `both`, or `none` (local use only) |
| `APPROVAL_MODE` | `minimal` | `minimal` or `standard` tool annotations |
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
- **Client cannot connect:** web clients need an HTTPS tunnel and the matching `PUBLIC_URL`; restart `mcp` after changing it.
- **Files are owned by the wrong user:** confirm `UID` and `GID` in `.env` match `id -u` and `id -g`, then recreate the service.
- **Quick Tunnel URL is missing:** wait a few seconds and run `./scripts/tunnel-url.sh` again, or inspect `docker compose --profile tunnel logs -f tunnel`.

## License

MIT. See [LICENSE](LICENSE).
