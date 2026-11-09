/**
 * Owned by agy1. Admin UI + REST API listener (ADMIN_PORT 8788).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import type { AppConfig } from "../config.js";
import type { ActivityLog } from "../core/activity.js";
import type { Board, RequestStatus } from "../core/board.js";
import type { PluginHub } from "../core/plugins.js";
import type { CommandRegistry } from "../commands/registry.js";
import type { SkillRegistry } from "../skills/registry.js";
import { getSettings, updateSettings } from "../core/settings.js";
import { invalidateAllOAuthTokens } from "../http/oauth-store.js";
import type { SessionManager } from "../http/session-manager.js";
import { getLocalBaseUrl, resolvePublicUrl } from "../http/public-url.js";
import { detectIntegrations } from "../core/integrations.js";
import toolModules from "../tools/index.js";
import { ESSENTIAL_TOOLS } from "../mcp/server.js";
import { getAgentMemory } from "../tools/lib/memory.js";
import { loadRecipes } from "../plugins/recipes.js";
import { parsePluginImport } from "../plugins/import.js";
import {
  resolveWorkspaces,
  validateWorkspacePath,
  validateDefaultWorkspace,
} from "../core/workspace.js";

export interface ClientConnectInfo {
  id: string;
  name: string;
  kind: "web" | "desktop" | "cli" | "editor" | "generic";
  auth: "oauth" | "bearer" | "url-token";
  url: string;
  steps: string[];
  snippet?: string;
  snippetLang?: "bash" | "json" | "toml";
  configPath?: string;
}

export interface AdminAppDependencies {
  config: AppConfig;
  activity: ActivityLog;
  skills: SkillRegistry;
  commands: CommandRegistry;
  sessionManager: SessionManager;
  board?: Board;
  pluginHub?: PluginHub;
}

function isValidHost(hostHeader?: string): boolean {
  if (!hostHeader) return false;
  // Strip port from host header: "localhost:8788" -> "localhost", "[::1]:8788" -> "[::1]"
  let host = hostHeader.trim().toLowerCase();
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end !== -1) host = host.slice(0, end + 1);
  } else {
    host = host.split(":")[0];
  }
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

function resolveWebDir(): string {
  const candidates = [
    path.resolve(process.cwd(), "web"),
    fileURLToPath(new URL("../../web", import.meta.url)),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0];
}

export function createAdminApp(deps: AdminAppDependencies): Express {
  const app = express();
  const webDir = resolveWebDir();

  // Host-header DNS rebinding guard
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!isValidHost(req.headers.host)) {
      res.status(403).json({ error: "Forbidden: invalid Host header" });
      return;
    }
    next();
  });

  app.use(express.json({ limit: "50mb" }));

  // REST API prefix: /api

  // 1. GET /api/status
  app.get("/api/status", async (_req: Request, res: Response) => {
    const publicUrl = await resolvePublicUrl(deps.config);
    const localUrl = getLocalBaseUrl(deps.config);
    const settings = getSettings();
    const effectiveWs = resolveWorkspaces(deps.config, settings);
    const effectiveBase = publicUrl || localUrl;
    const integrations = await detectIntegrations();
    const openRequests = deps.board ? (await deps.board.listRequests({ status: "open" })).length : 0;

    res.json({
      version: deps.config.version,
      uptimeSec: Math.floor(process.uptime()),
      authMode: deps.config.authMode,
      toolProfile: settings.toolProfile ?? deps.config.toolProfile,
      approvalMode: settings.approvalMode ?? deps.config.approvalMode,
      sessions: deps.sessionManager.count(),
      workspaceRoots: effectiveWs.roots,
      defaultWorkspace: effectiveWs.defaultWorkspace,
      workspaceSource: effectiveWs.source,
      mountDirs: deps.config.mountDirs ?? [],
      lastWorkspace: settings.lastWorkspace,
      integrations,
      openRequests,
      endpoints: {
        local: localUrl,
        public: publicUrl,
        mcpUrlWithToken: `${effectiveBase}/mcp/${deps.config.mcpToken}`,
        pluginsUrlWithToken: `${effectiveBase}/mcp/plugins/${deps.config.mcpToken}`,
        oauthIssuer: effectiveBase,
      },
    });
  });

  // 1b. GET /api/health — proxies MCP server's internal /health
  app.get("/api/health", async (_req: Request, res: Response) => {
    try {
      const resp = await fetch(`http://127.0.0.1:${deps.config.port}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      if (resp.ok) {
        const data = (await resp.json()) as Record<string, unknown>;
        res.json({
          ...data,
          mcpReachable: true,
        });
        return;
      }
      res.status(resp.status).json({
        ok: false,
        mcpReachable: false,
        error: `MCP server returned HTTP ${resp.status}`,
      });
    } catch (err) {
      res.status(503).json({
        ok: false,
        mcpReachable: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // 2. GET /api/connect
  app.get("/api/connect", async (_req: Request, res: Response) => {
    const publicUrl = await resolvePublicUrl(deps.config);
    const localUrl = getLocalBaseUrl(deps.config);
    const token = deps.config.mcpToken;
    const effectiveBase = publicUrl || localUrl;
    const mcpUrlWithToken = `${effectiveBase}/mcp/${token}`;
    const mcpUrl = `${effectiveBase}/mcp`;
    const pluginsUrlWithToken = `${effectiveBase}/mcp/plugins/${token}`;

    const chatgptSteps = publicUrl
      ? [
          "Open ChatGPT and go to Settings → Apps & Connectors",
          "Click Advanced → Developer mode → Create",
          "Enter Name 'Local Coder', paste the URL, and select 'No auth'",
          "Click Create to connect your agent",
        ]
      : [
          "NOTE: ChatGPT web requires a public HTTPS URL. Run: docker compose --profile tunnel up -d",
          "Open ChatGPT and go to Settings → Apps & Connectors",
          "Click Advanced → Developer mode → Create",
          "Enter Name 'Local Coder', paste the URL, and select 'No auth' (or OAuth)",
          "Click Create to connect your agent",
        ];

    const geminiSteps = publicUrl
      ? [
          "Open Gemini and go to Settings → Connected apps",
          "Click 'Add custom app'",
          "Paste the MCP server URL",
          "Sign in via OAuth using your Access Key (MCP_TOKEN)",
        ]
      : [
          "NOTE: Gemini web requires a public HTTPS URL. Run: docker compose --profile tunnel up -d",
          "Open Gemini and go to Settings → Connected apps",
          "Click 'Add custom app'",
          "Paste the MCP server URL",
          "Sign in via OAuth using your Access Key (MCP_TOKEN)",
        ];

    const clients: ClientConnectInfo[] = [
      {
        id: "chatgpt",
        name: "ChatGPT",
        kind: "web",
        auth: "oauth",
        url: mcpUrl,
        steps: publicUrl
          ? [
              "Open ChatGPT and go to Settings > Apps & Connectors > Advanced > Developer mode > Create",
              `MCP Server URL: ${mcpUrl}`,
              `Authentication: OAuth (sign in with your access key), or No auth with ${mcpUrlWithToken}`,
            ]
          : [
              "NOTE: ChatGPT web requires a public HTTPS URL. Run: docker compose --profile tunnel up -d",
              "Open ChatGPT and go to Settings > Apps & Connectors > Advanced > Developer mode > Create",
              `MCP Server URL: ${mcpUrl}`,
              `Authentication: OAuth (sign in with your access key), or No auth with ${mcpUrlWithToken}`,
            ],
      },
      {
        id: "gemini",
        name: "Gemini web",
        kind: "web",
        auth: "oauth",
        url: mcpUrl,
        steps: publicUrl
          ? [
              "Open Gemini and go to Settings > Connected apps > Add custom app",
              `MCP Server URL: ${mcpUrl}`,
              "Leave Client ID and secret empty",
              "Sign in via OAuth using your access key",
            ]
          : [
              "NOTE: Gemini web requires a public HTTPS URL. Run: docker compose --profile tunnel up -d",
              "Open Gemini and go to Settings > Connected apps > Add custom app",
              `MCP Server URL: ${mcpUrl}`,
              "Leave Client ID and secret empty",
              "Sign in via OAuth using your access key",
            ],
      },
      {
        id: "claude",
        name: "Claude.ai / Claude Desktop",
        kind: "desktop",
        auth: "oauth",
        url: mcpUrl,
        steps: publicUrl
          ? [
              "Open Claude and go to Settings > Connectors > Add custom connector",
              `MCP Server URL: ${mcpUrl}`,
              "Sign in via OAuth using your access key",
            ]
          : [
              "NOTE: Claude.ai web requires a public HTTPS URL. Run: docker compose --profile tunnel up -d (or use local URL for Claude Desktop)",
              "Open Claude and go to Settings > Connectors > Add custom connector",
              `MCP Server URL: ${mcpUrl}`,
              "Sign in via OAuth using your access key",
            ],
      },
      {
        id: "claude-code",
        name: "Claude Code",
        kind: "cli",
        auth: "bearer",
        url: mcpUrl,
        snippetLang: "bash",
        snippet: `claude mcp add --transport http local-coder "${mcpUrl}" --header "Authorization: Bearer ${token}"`,
        steps: [
          "Run the command below in your terminal:",
          `claude mcp add --transport http local-coder "${mcpUrl}" --header "Authorization: Bearer ${token}"`,
        ],
      },
      {
        id: "cursor",
        name: "Cursor",
        kind: "editor",
        auth: "bearer",
        url: mcpUrl,
        configPath: "~/.cursor/mcp.json",
        snippetLang: "json",
        snippet: JSON.stringify(
          {
            mcpServers: {
              "local-coder": {
                url: mcpUrl,
                headers: {
                  Authorization: `Bearer ${token}`,
                },
              },
            },
          },
          null,
          2
        ),
        steps: [
          "Add the configuration below to ~/.cursor/mcp.json:",
          "Restart Cursor or reload MCP servers in Settings > Features > MCP",
        ],
      },
      {
        id: "vscode",
        name: "VS Code",
        kind: "editor",
        auth: "bearer",
        url: mcpUrl,
        configPath: ".vscode/mcp.json",
        snippetLang: "json",
        snippet: JSON.stringify(
          {
            servers: {
              "local-coder": {
                type: "http",
                url: mcpUrl,
                headers: {
                  Authorization: `Bearer ${token}`,
                },
              },
            },
          },
          null,
          2
        ),
        steps: [
          "Add the configuration below to .vscode/mcp.json in your workspace:",
          "Reload MCP servers from the Command Palette",
        ],
      },
      {
        id: "gemini-cli",
        name: "Gemini CLI",
        kind: "cli",
        auth: "bearer",
        url: mcpUrl,
        configPath: "~/.gemini/settings.json",
        snippetLang: "json",
        snippet: JSON.stringify(
          {
            mcpServers: {
              "local-coder": {
                httpUrl: mcpUrl,
                headers: {
                  Authorization: `Bearer ${token}`,
                },
              },
            },
          },
          null,
          2
        ),
        steps: [
          "Add the configuration below to ~/.gemini/settings.json:",
          "Launch your Gemini CLI session",
        ],
      },
      {
        id: "codex-cli",
        name: "Codex CLI",
        kind: "cli",
        auth: "bearer",
        url: mcpUrl,
        configPath: "~/.codex/config.toml",
        snippetLang: "toml",
        snippet: `[mcp_servers.local-coder]\nurl = "${mcpUrl}"\nbearer_token_env_var = "LOCAL_CODER_TOKEN"\n# export LOCAL_CODER_TOKEN="${token}"`,
        steps: [
          "Add the configuration below to ~/.codex/config.toml:",
          `[mcp_servers.local-coder]\nurl = "${mcpUrl}"\nbearer_token_env_var = "LOCAL_CODER_TOKEN"`,
          `Export the token in your shell: export LOCAL_CODER_TOKEN="${token}"`,
        ],
      },
      {
        id: "generic",
        name: "Generic MCP Client",
        kind: "generic",
        auth: "bearer",
        url: mcpUrl,
        snippetLang: "bash",
        snippet: `curl -s -N -H "Authorization: Bearer ${token}" "${mcpUrl}"`,
        steps: [
          "Connect any client supporting remote Streamable HTTP MCP",
          `Endpoint URL: ${mcpUrl}`,
          `Header: Authorization: Bearer ${token} (or URL path /mcp/${token})`,
          `OAuth 2.1 metadata endpoint: ${effectiveBase}/.well-known/oauth-authorization-server`,
        ],
      },
    ];

    res.json({
      clients,
      chatgpt: {
        url: mcpUrlWithToken,
        steps: chatgptSteps,
      },
      gemini: {
        url: mcpUrl,
        steps: geminiSteps,
      },
      plugins: {
        url: pluginsUrlWithToken,
      },
      token,
    });
  });

  // 3. POST /api/token/rotate
  app.post("/api/token/rotate", (_req: Request, res: Response) => {
    try {
      const newToken = crypto.randomBytes(24).toString("hex");
      deps.config.mcpToken = newToken;

      const tokenFile = path.join(deps.config.dataDir, "token");
      fs.mkdirSync(deps.config.dataDir, { recursive: true });
      fs.writeFileSync(tokenFile, newToken, { encoding: "utf-8", mode: 0o600 });

      // Invalidate OAuth tokens
      invalidateAllOAuthTokens();

      res.json({ token: newToken });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // 4. Tools API
  app.get("/api/tools", (_req: Request, res: Response) => {
    const settings = getSettings();
    const disabled = new Set(settings.disabledTools);
    const allTools = (toolModules ?? []).flat();

    const list = allTools.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      group: t.group,
      risk: t.risk,
      enabled: !disabled.has(t.name),
      profile: ESSENTIAL_TOOLS.has(t.name) ? ("essential" as const) : ("full" as const),
    }));

    res.json(list);
  });

  app.patch("/api/tools/:name", async (req: Request, res: Response) => {
    try {
      const name = String(req.params.name);
      const { enabled } = req.body || {};
      if (typeof enabled !== "boolean") {
        res.status(400).json({ error: "Missing boolean 'enabled' in request body" });
        return;
      }

      const settings = getSettings();
      const disabled = new Set(settings.disabledTools);
      if (enabled) {
        disabled.delete(name);
      } else {
        disabled.add(name);
      }

      await updateSettings({ disabledTools: Array.from(disabled) });
      res.json({ ok: true, name, enabled });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // 5. Skills API
  app.get("/api/skills", async (_req: Request, res: Response) => {
    try {
      const list = await deps.skills.list({ includeDisabled: true });
      res.json(list);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/skills/:name", async (req: Request, res: Response) => {
    try {
      const name = String(req.params.name);
      const skill = await deps.skills.get(name);
      if (!skill) {
        res.status(404).json({ error: "Skill not found" });
        return;
      }
      res.json(skill);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/skills", async (req: Request, res: Response) => {
    try {
      const summary = await deps.skills.save(req.body);
      res.status(201).json(summary);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/skills/import", async (req: Request, res: Response) => {
    try {
      const { markdown, files, path: importPath } = req.body || {};
      if (importPath) {
        const summary = await deps.skills.importFromPath(importPath);
        res.status(201).json(summary);
        return;
      }
      if (markdown) {
        const summary = await deps.skills.importMarkdown(markdown, files);
        res.status(201).json(summary);
        return;
      }
      res.status(400).json({ error: "Provide either 'path' or 'markdown' to import skill" });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.patch("/api/skills/:name", async (req: Request, res: Response) => {
    try {
      const name = String(req.params.name);
      const { enabled } = req.body || {};
      if (typeof enabled !== "boolean") {
        res.status(400).json({ error: "Missing boolean 'enabled'" });
        return;
      }
      await deps.skills.setEnabled(name, enabled);
      res.json({ ok: true, name, enabled });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete("/api/skills/:name", async (req: Request, res: Response) => {
    try {
      const name = String(req.params.name);
      await deps.skills.remove(name);
      res.status(204).end();
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // 6. Commands API
  app.get("/api/commands", async (_req: Request, res: Response) => {
    try {
      const list = await deps.commands.list();
      res.json(list);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/commands/:name", async (req: Request, res: Response) => {
    try {
      const name = String(req.params.name);
      const cmd = await deps.commands.get(name);
      if (!cmd) {
        res.status(404).json({ error: "Command not found" });
        return;
      }
      res.json(cmd);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/commands", async (req: Request, res: Response) => {
    try {
      const summary = await deps.commands.save(req.body);
      res.status(201).json(summary);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete("/api/commands/:name", async (req: Request, res: Response) => {
    try {
      const name = String(req.params.name);
      await deps.commands.remove(name);
      res.status(204).end();
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // 7. Settings API
  app.get("/api/settings", (_req: Request, res: Response) => {
    res.json(getSettings());
  });

  app.patch("/api/settings", async (req: Request, res: Response) => {
    try {
      const { approvalMode, toolProfile } = req.body || {};

      if (approvalMode !== undefined) {
        if (!["trust", "minimal", "standard"].includes(approvalMode)) {
          res.status(400).json({ error: "Invalid approvalMode. Expected 'trust', 'minimal', or 'standard'." });
          return;
        }
      }

      if (toolProfile !== undefined) {
        if (!["essential", "full"].includes(toolProfile)) {
          res.status(400).json({ error: "Invalid toolProfile. Expected 'essential' or 'full'." });
          return;
        }
      }

      const updated = await updateSettings(req.body || {});

      if (approvalMode !== undefined) {
        await deps.sessionManager.applyApprovalModeLive(approvalMode);
      }

      res.json(updated);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // 8. Activity API
  app.get("/api/activity", (req: Request, res: Response) => {
    const limit = Number(req.query.limit) || 100;
    res.json(deps.activity.recent(limit));
  });

  app.get("/api/activity/stream", (req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    res.write(": connected\n\n");

    const unsubscribe = deps.activity.subscribe((entry) => {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    });

    req.on("close", () => {
      unsubscribe();
    });
  });

  // 9. Board API (requests, finishes, plan, stream)
  app.get("/api/requests", async (req: Request, res: Response) => {
    try {
      if (!deps.board) {
        res.json([]);
        return;
      }
      const workspace = req.query.workspace ? String(req.query.workspace) : undefined;
      const status = req.query.status ? (String(req.query.status) as RequestStatus) : undefined;
      const requests = await deps.board.listRequests({ workspace, status });
      res.json(requests);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/requests/:id", async (req: Request, res: Response) => {
    try {
      if (!deps.board) {
        res.status(500).json({ error: "Board is not available" });
        return;
      }
      const id = String(req.params.id);
      const { status, note } = req.body || {};
      if (status !== "done" && status !== "skipped") {
        res.status(400).json({ error: "Invalid status: expected 'done' or 'skipped'" });
        return;
      }
      const existing = await deps.board.getRequest(id);
      if (!existing) {
        res.status(404).json({ error: `Request not found: ${id}` });
        return;
      }
      const updated = await deps.board.setRequestStatus(id, status, typeof note === "string" ? note : undefined);
      res.json(updated);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found")) {
        res.status(404).json({ error: msg });
      } else {
        res.status(400).json({ error: msg });
      }
    }
  });

  app.get("/api/finishes", async (req: Request, res: Response) => {
    try {
      if (!deps.board) {
        res.json([]);
        return;
      }
      const limit = req.query.limit ? Number(req.query.limit) : undefined;
      const workspace = req.query.workspace ? String(req.query.workspace) : undefined;
      const finishes = await deps.board.listFinishes({ workspace, limit });
      res.json(finishes);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/plan", async (req: Request, res: Response) => {
    try {
      const settings = getSettings();
      const effectiveWs = resolveWorkspaces(deps.config, settings);
      const workspace =
        (req.query.workspace ? String(req.query.workspace) : undefined) ||
        settings.lastWorkspace ||
        effectiveWs.defaultWorkspace;
      const memory = await getAgentMemory(deps.config.dataDir, workspace);
      res.json({
        workspace,
        todos: memory.todos,
        updatedAt: memory.updatedAt,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/board/stream", (req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    res.write(": connected\n\n");

    if (!deps.board) {
      req.on("close", () => {});
      return;
    }

    const unsubscribe = deps.board.subscribe((event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });

    const heartbeat = setInterval(() => {
      res.write(": heartbeat\n\n");
    }, 15000);

    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  // 10. Plugins Hub API
  app.get("/api/plugins", (_req: Request, res: Response) => {
    res.json(deps.pluginHub?.list() ?? []);
  });

  app.get("/api/plugins/recipes", async (_req: Request, res: Response) => {
    try {
      const recipes = await loadRecipes(deps.config.builtinPluginsDir);
      res.json(recipes);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/plugins", async (req: Request, res: Response) => {
    if (!deps.pluginHub) {
      res.status(503).json({ error: "Plugin hub is not available" });
      return;
    }
    if (!req.body || typeof req.body !== "object") {
      res.status(400).json({ error: "Missing plugin input body" });
      return;
    }
    try {
      const summary = await deps.pluginHub.add(req.body);
      res.status(201).json(summary);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/plugins/import/preview", (req: Request, res: Response) => {
    const { text } = req.body || {};
    if (typeof text !== "string" || !text.trim()) {
      res.status(400).json({ error: "Missing or empty 'text' in request body" });
      return;
    }
    const result = parsePluginImport(text);
    if (!result.plugins || result.plugins.length === 0) {
      res.status(400).json({
        error: "Could not parse any plugin configurations from the provided text",
        warnings: result.warnings,
      });
      return;
    }
    res.json(result);
  });

  app.get("/api/plugins/:id", (req: Request, res: Response) => {
    if (!deps.pluginHub) {
      res.status(503).json({ error: "Plugin hub is not available" });
      return;
    }
    const id = String(req.params.id);
    const detail = deps.pluginHub.get(id);
    if (!detail) {
      res.status(404).json({ error: `Plugin not found: ${id}` });
      return;
    }
    res.json(detail);
  });

  app.patch("/api/plugins/:id", async (req: Request, res: Response) => {
    if (!deps.pluginHub) {
      res.status(503).json({ error: "Plugin hub is not available" });
      return;
    }
    const id = String(req.params.id);
    const existing = deps.pluginHub.get(id);
    if (!existing) {
      res.status(404).json({ error: `Plugin not found: ${id}` });
      return;
    }
    try {
      const updated = await deps.pluginHub.update(id, req.body || {});
      res.json(updated);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete("/api/plugins/:id", async (req: Request, res: Response) => {
    if (!deps.pluginHub) {
      res.status(503).json({ error: "Plugin hub is not available" });
      return;
    }
    const id = String(req.params.id);
    const existing = deps.pluginHub.get(id);
    if (!existing) {
      res.status(404).json({ error: `Plugin not found: ${id}` });
      return;
    }
    try {
      await deps.pluginHub.remove(id);
      res.status(204).end();
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/plugins/:id/restart", async (req: Request, res: Response) => {
    if (!deps.pluginHub) {
      res.status(503).json({ error: "Plugin hub is not available" });
      return;
    }
    const id = String(req.params.id);
    const existing = deps.pluginHub.get(id);
    if (!existing) {
      res.status(404).json({ error: `Plugin not found: ${id}` });
      return;
    }
    try {
      const restarted = await deps.pluginHub.restart(id);
      res.json(restarted);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.patch("/api/plugins/:id/tools/:tool", async (req: Request, res: Response) => {
    if (!deps.pluginHub) {
      res.status(503).json({ error: "Plugin hub is not available" });
      return;
    }
    const id = String(req.params.id);
    const tool = String(req.params.tool);
    const { enabled } = req.body || {};
    if (typeof enabled !== "boolean") {
      res.status(400).json({ error: "Missing boolean 'enabled'" });
      return;
    }
    const existing = deps.pluginHub.get(id);
    if (!existing) {
      res.status(404).json({ error: `Plugin not found: ${id}` });
      return;
    }
    try {
      const updatedTool = await deps.pluginHub.setToolEnabled(id, tool, enabled);
      res.json(updatedTool);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // 11. Workspaces API
  app.put("/api/workspaces", async (req: Request, res: Response) => {
    try {
      const { roots, defaultWorkspace } = req.body || {};
      if (!Array.isArray(roots) || roots.length === 0) {
        res.status(400).json({ error: "At least one workspace root is required in 'roots'." });
        return;
      }

      const allowedAreas = deps.config.allowedRootAreas ?? deps.config.workspaceRoots ?? [];
      const validatedRoots: string[] = [];

      for (const r of roots) {
        if (!r || typeof r !== "string" || !r.trim()) {
          res.status(400).json({ error: "Workspace root path cannot be empty." });
          return;
        }
        const validated = validateWorkspacePath(r.trim(), allowedAreas);
        validatedRoots.push(validated);
      }

      let validatedDefault: string;
      if (defaultWorkspace !== undefined && defaultWorkspace !== null && typeof defaultWorkspace === "string" && defaultWorkspace.trim()) {
        validatedDefault = validateDefaultWorkspace(defaultWorkspace.trim(), validatedRoots);
      } else {
        validatedDefault = validatedRoots[0];
      }

      await updateSettings({
        workspaceRoots: validatedRoots,
        defaultWorkspace: validatedDefault,
      });

      await deps.sessionManager.applyWorkspacesLive();

      res.json({
        roots: validatedRoots,
        defaultWorkspace: validatedDefault,
        source: "settings",
      });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete("/api/workspaces", async (_req: Request, res: Response) => {
    try {
      await updateSettings({
        workspaceRoots: undefined,
        defaultWorkspace: undefined,
      });

      await deps.sessionManager.applyWorkspacesLive();

      const effective = resolveWorkspaces(deps.config, getSettings());
      res.json({
        roots: effective.roots,
        defaultWorkspace: effective.defaultWorkspace,
        source: "env",
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // 12. Filesystem Browsing API (for folder picker)
  app.get("/api/fs/dirs", (req: Request, res: Response) => {
    try {
      const allowedAreas = deps.config.allowedRootAreas ?? deps.config.workspaceRoots ?? [];
      const effective = resolveWorkspaces(deps.config, getSettings());

      const requestedPath = req.query.path ? String(req.query.path).trim() : "";
      const targetPath = requestedPath
        ? path.resolve(requestedPath)
        : (deps.config.mountDirs?.[0] ?? effective.roots[0]);

      if (!fs.existsSync(targetPath)) {
        res.status(400).json({ error: `Directory does not exist: ${targetPath}` });
        return;
      }
      let stat: fs.Stats;
      try {
        stat = fs.statSync(targetPath);
      } catch {
        res.status(400).json({ error: `Cannot access directory: ${targetPath}` });
        return;
      }
      if (!stat.isDirectory()) {
        res.status(400).json({ error: `Path is not a directory: ${targetPath}` });
        return;
      }

      // Check if targetPath is inside allowed areas
      const realTarget = fs.realpathSync(targetPath);
      const isTargetAllowed = allowedAreas.some((area) => {
        let realArea = path.resolve(area);
        try { realArea = fs.realpathSync(realArea); } catch {}
        return realTarget === realArea || realTarget.startsWith(realArea.endsWith(path.sep) ? realArea : realArea + path.sep);
      });

      if (!isTargetAllowed) {
        res.status(400).json({ error: `Path '${targetPath}' is outside the allowed mount areas.` });
        return;
      }

      // Determine parent if parent is inside allowed areas
      let parent: string | undefined;
      const parentCandidate = path.dirname(targetPath);
      if (parentCandidate !== targetPath) {
        try {
          const realParent = fs.realpathSync(parentCandidate);
          const isParentAllowed = allowedAreas.some((area) => {
            let realArea = path.resolve(area);
            try { realArea = fs.realpathSync(realArea); } catch {}
            return realParent === realArea || realParent.startsWith(realArea.endsWith(path.sep) ? realArea : realArea + path.sep);
          });
          if (isParentAllowed) {
            parent = parentCandidate;
          }
        } catch {}
      }

      // Read directory entries
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(targetPath, { withFileTypes: true });
      } catch (readErr) {
        res.status(400).json({ error: `Failed to read directory: ${readErr instanceof Error ? readErr.message : String(readErr)}` });
        return;
      }

      const dirs: { name: string; path: string; isGitRepo: boolean }[] = [];

      for (const entry of entries) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") {
          continue;
        }

        const fullPath = path.join(targetPath, entry.name);
        let isDir = false;
        let realEntryPath = "";
        try {
          const st = fs.statSync(fullPath);
          isDir = st.isDirectory();
          if (isDir) {
            realEntryPath = fs.realpathSync(fullPath);
          }
        } catch {
          continue;
        }

        if (!isDir) continue;

        // Check if inside allowed areas
        const isEntryAllowed = allowedAreas.some((area) => {
          let realArea = path.resolve(area);
          try { realArea = fs.realpathSync(realArea); } catch {}
          return realEntryPath === realArea || realEntryPath.startsWith(realArea.endsWith(path.sep) ? realArea : realArea + path.sep);
        });

        if (!isEntryAllowed) continue;

        const isGitRepo = fs.existsSync(path.join(fullPath, ".git"));
        dirs.push({
          name: entry.name,
          path: fullPath,
          isGitRepo,
        });

        if (dirs.length >= 500) {
          break;
        }
      }

      dirs.sort((a, b) => a.name.localeCompare(b.name));

      res.json({
        path: targetPath,
        parent,
        dirs,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Static serving of web/ directory at /
  if (fs.existsSync(webDir)) {
    app.use(express.static(webDir));
  }

  // SPA fallback for HTML requests
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method !== "GET" || req.path.startsWith("/api/")) return next();
    const indexHtml = path.join(webDir, "index.html");
    if (fs.existsSync(indexHtml)) {
      res.sendFile(indexHtml);
    } else {
      res.type("html").send(
        "<!DOCTYPE html><html><head><title>Local Coder MCP</title></head><body><h1>Local Coder MCP</h1><p>Admin UI loading...</p></body></html>"
      );
    }
  });

  return app;
}
