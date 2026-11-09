# Docker setup

The supported setup uses Docker Compose v2 and Node 22 inside a multi-stage image. The container runs as the host UID/GID configured in `.env`; `/data` stores server state, while the projects directory is mounted at its original absolute path so MCP file paths match host paths.

## Install

```sh
./scripts/setup.sh
```

The setup script checks Docker and Compose, creates `.env` without replacing an existing file, generates an access key once, asks for a projects directory, records the current host UID/GID, builds the image, and starts the service. Use `--yes` for non-interactive setup with `~/Projects` as the default.

Open [http://localhost:8788](http://localhost:8788) and choose your AI client on the **Connect** page. The MCP endpoint is `/mcp`; the page shows the access key and OAuth or Bearer connection details. The server always listens on `8787` for MCP and `8788` for admin inside the container. `PORT` and `ADMIN_PORT` in `.env` select the host ports Compose publishes; for example, `PORT=3000` maps host port `3000` to MCP port `8787` and is passed to the server as `HOST_PORT`.

## Optional host tools and skills

Setup detects a Herdr CLI and its live socket at `~/.config/herdr/herdr.sock` and automatically writes `COMPOSE_FILE=compose.yaml:compose.host-tools.yaml` to `.env`. The host config directory is mounted read-write at the same absolute path, with `HOME`, `XDG_CONFIG_HOME`, and `HERDR_ENV=1` set for the container. Set `HERDR_BIN` in `.env` to use a non-default binary path. The setup summary reports whether integration was enabled.

If configuring manually and host skills are under `~/.agents/skills`, run Compose with the override:

```sh
docker compose -f compose.yaml -f compose.host-tools.yaml up -d --build
```

This mounts the host binary read-only, the Herdr config and socket read-write, and host skills read-only. Herdr controls real host terminals, so keep the Local Coder access key protected. For skill discovery without Herdr, the skills mount alone can be enabled by adapting the override to your environment.

## Operations

```sh
docker compose up -d --build   # build and start
docker compose logs -f         # follow logs
docker compose down            # stop
./scripts/e2e.sh               # container and MCP smoke check
```

The container health check calls `/health`. MCP and admin ports bind only to loopback on the host. Start a Quick Tunnel with `docker compose --profile tunnel up -d`; its URL is discovered automatically and appears in the admin UI. If you already have a domain or tunnel, route it to the host `PORT`, set `PUBLIC_URL=https://your-domain`, and skip the tunnel profile. A stable named Cloudflare tunnel uses `docker compose --profile named-tunnel up -d named-tunnel` with `CLOUDFLARE_TUNNEL_TOKEN` and `PUBLIC_URL` set in `.env`. `PUBLIC_URL` also configures Tailscale Funnel or ngrok. See the main [README](../README.md#getting-a-public-https-url) for details.

The runtime includes headless Chromium at `CHROMIUM_PATH` for the read-only `browser_check` screenshot tool. It runs as the non-root service user, with a 1 GB shared-memory segment for rendering. Any MCP client supporting remote Streamable HTTP can connect using the endpoint and authentication details on the Connect page.
