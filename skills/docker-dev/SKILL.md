---
name: docker-dev
description: "Best practices for Docker and Docker Compose development: multi-stage builds, layer caching, compose configurations, and debugging containers."
---

# Docker & Compose Development Guide

Production-ready patterns for containerized development, building optimized Dockerfiles, orchestrating with Compose, and diagnosing container issues.

## 1. Dockerfile Best Practices

### Multi-Stage Builds
Separate build tooling from production runtime to keep images minimal and secure:

```dockerfile
# Build stage
FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Production stage
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN groupadd -g 1001 nodejs && useradd -u 1001 -g nodejs nodejs
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
USER nodejs
EXPOSE 8787
CMD ["node", "dist/index.js"]
```

### Layer Caching Optimization
- Copy dependency manifests (`package.json`, `Cargo.toml`, `go.mod`, `requirements.txt`) before copying application source code.
- Combine closely related commands with `&&` to minimize layer count.
- Order commands from least frequently changed (OS dependencies, tools) to most frequently changed (application source code).

### Security & Sizing
- **Non-root user**: Always specify `USER <name>` before the entrypoint/cmd.
- **Minimal base image**: Use `-slim`, `-alpine`, or distroless images.
- **.dockerignore**: Exclude `.git`, `node_modules`, `dist`, `.env`, temporary logs, and build artifacts from the build context.

## 2. Docker Compose Configuration Patterns

### Development Compose Example
```yaml
services:
  app:
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "127.0.0.1:8787:8787"
      - "127.0.0.1:8788:8788"
    volumes:
      - ./:/workspace:cached
      - /data
    environment:
      - PORT=8787
      - ADMIN_PORT=8788
      - LOG_LEVEL=debug
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8787/health"]
      interval: 10s
      timeout: 5s
      retries: 3
    restart: unless-stopped
```

### Key Compose Rules
- **Loopback binding**: Bind host ports explicitly to `127.0.0.1:port:port` to prevent unintended public exposure.
- **Healthchecks**: Always define a healthcheck for long-running services so dependent services can wait (`depends_on.condition: service_healthy`).
- **Consistent UID/GID**: Pass `user: "${UID:-1000}:${GID:-1000}"` when mounting host workspace files so created files retain host ownership.

## 3. Container Debugging & Diagnostics

When diagnosing container issues in Local Coder MCP using `run`:

### Check Container Status & Logs
```bash
# View active and exited containers
docker ps -a

# Inspect recent logs with timestamps
docker logs --tail 100 --timestamps <container_name_or_id>

# Follow live output
docker logs -f <container_name_or_id>
```

### Interactive Shell & Inspection
```bash
# Open an interactive shell inside a running container
docker exec -it <container> sh -c "bash || sh"

# Inspect process state and open ports
docker exec <container> ps aux
docker exec <container> netstat -tuln

# Inspect environment variables
docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' <container>

# Inspect healthcheck status
docker inspect --format '{{json .State.Health}}' <container>
```

### Common Issues & Quick Fixes
1. **Container exits immediately with code 0 or 1**:
   Check `docker logs <container>`. Ensure the foreground process does not detach or daemonize.
2. **Port already in use**:
   Run `ss -tulpn | grep <port>` or `lsof -i :<port>` to find the host process occupying the port.
3. **Permission denied in bind mounts**:
   Verify user ID matching between host user and container user.
4. **DNS or network unreachable inside container**:
   Check Docker daemon network bridge: `docker network inspect bridge`.
