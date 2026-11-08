# Docker setup

The supported setup uses Docker Compose v2 and Node 22 inside a multi-stage image. The container runs as the host UID/GID configured in `.env`; `/data` stores server state, while the projects directory is mounted at its original absolute path so MCP file paths match host paths.

## Install

```sh
./scripts/setup.sh
```

The setup script checks Docker and Compose, creates `.env` without replacing an existing file, generates an access key once, asks for a projects directory, records the current UID/GID, builds the image, and starts the service. Use `--yes` for non-interactive setup with `~/Projects` as the default.

Open [http://localhost:8788](http://localhost:8788) for status and client connection details. The MCP listener is `127.0.0.1:8787`; the admin listener is `127.0.0.1:8788` on the host.

## Optional host tools and skills

If `herdr` is installed at `~/.local/bin/herdr`, and host skills are under `~/.agents/skills`, run Compose with the override:

```sh
docker compose -f compose.yaml -f compose.host-tools.yaml up -d --build
```

This mounts the host binary, its config, and skills read-only. For skill discovery without Herdr, the skills mount alone can be enabled by adapting the override to your environment.

## Operations

```sh
docker compose up -d --build   # build and start
docker compose logs -f         # follow logs
docker compose down            # stop
./scripts/e2e.sh               # container and MCP smoke check
```

The container health check calls `/health`. MCP and admin ports bind only to loopback on the host. The optional `tunnel` profile forwards only MCP traffic. A stable named Cloudflare tunnel uses `docker compose --profile named-tunnel up -d named-tunnel` with `CLOUDFLARE_TUNNEL_TOKEN` in `.env`. See the main [README](../README.md#getting-a-public-https-url) for public HTTPS setup and alternatives.
