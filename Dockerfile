FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=8787 ADMIN_PORT=8788 HOST=0.0.0.0 ADMIN_HOST=0.0.0.0 DATA_DIR=/data BUILTIN_SKILLS_DIR=/app/skills USER_SKILLS_DIR=/data/skills BUILTIN_COMMANDS_DIR=/app/commands USER_COMMANDS_DIR=/data/commands CHROMIUM_PATH=/usr/bin/chromium
RUN apt-get update && apt-get install -y --no-install-recommends bash build-essential ca-certificates chromium curl fonts-liberation git jq openssh-client python3 ripgrep tini \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system app \
    && useradd --system --gid app --home-dir /home/app --create-home app
WORKDIR /app
COPY --from=build --chown=app:app /app/dist ./dist
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --chown=app:app package.json ./package.json
COPY --chown=app:app web ./web
COPY --chown=app:app skills ./skills
COPY --chown=app:app commands ./commands
RUN mkdir -p /data && chown app:app /data
USER app
EXPOSE 8787 8788
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD curl --fail --silent http://127.0.0.1:8787/health || exit 1
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
