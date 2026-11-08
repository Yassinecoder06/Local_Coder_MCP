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
import type { CommandRegistry } from "../commands/registry.js";
import type { SkillRegistry } from "../skills/registry.js";
import { getSettings, updateSettings } from "../core/settings.js";
import { invalidateAllOAuthTokens } from "../http/oauth-store.js";
import type { SessionManager } from "../http/session-manager.js";
import { getLocalBaseUrl, resolvePublicUrl } from "../http/public-url.js";
import toolModules from "../tools/index.js";
import { ESSENTIAL_TOOLS } from "../mcp/server.js";

export interface AdminAppDependencies {
  config: AppConfig;
  activity: ActivityLog;
  skills: SkillRegistry;
  commands: CommandRegistry;
  sessionManager: SessionManager;
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
    const effectiveBase = publicUrl || localUrl;

    res.json({
      version: deps.config.version,
      uptimeSec: Math.floor(process.uptime()),
      authMode: deps.config.authMode,
      toolProfile: settings.toolProfile ?? deps.config.toolProfile,
      approvalMode: settings.approvalMode ?? deps.config.approvalMode,
      sessions: deps.sessionManager.count(),
      workspaceRoots: deps.config.workspaceRoots,
      defaultWorkspace: deps.config.defaultWorkspace,
      endpoints: {
        local: localUrl,
        public: publicUrl,
        mcpUrlWithToken: `${effectiveBase}/mcp/${deps.config.mcpToken}`,
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

    res.json({
      chatgpt: {
        url: mcpUrlWithToken,
        steps: chatgptSteps,
      },
      gemini: {
        url: mcpUrl,
        steps: geminiSteps,
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
      const updated = await updateSettings(req.body || {});
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
