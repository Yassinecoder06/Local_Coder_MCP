/**
 * Owned by agy1. Express application for the MCP server listener (PORT 8787).
 */
import express, { type Express, type Request, type Response } from "express";
import type { AppConfig } from "../config.js";
import type { ActivityLog } from "../core/activity.js";
import type { Board } from "../core/board.js";
import type { PluginHub } from "../core/plugins.js";
import type { CommandRegistry } from "../commands/registry.js";
import type { SkillRegistry } from "../skills/registry.js";
import { createAuthMiddleware } from "./auth-middleware.js";
import { createOAuthRouter } from "./oauth-routes.js";
import { SessionManager } from "./session-manager.js";
import { createPluginsMcpServer } from "../mcp/plugins-server.js";

export interface McpAppDependencies {
  config: AppConfig;
  activity: ActivityLog;
  skills: SkillRegistry;
  commands: CommandRegistry;
  sessionManager?: SessionManager;
  pluginsSessionManager?: SessionManager;
  board?: Board;
  pluginHub?: PluginHub;
}

export function createMcpApp(deps: McpAppDependencies): {
  app: Express;
  sessionManager: SessionManager;
  pluginsSessionManager?: SessionManager;
} {
  const app = express();
  const sessionManager = deps.sessionManager ?? new SessionManager(deps);
  const pluginsSessionManager =
    deps.pluginsSessionManager ??
    (deps.pluginHub
      ? new SessionManager({
          ...deps,
          serverFactory: (_ctx, sid, getHeaders) =>
            createPluginsMcpServer(deps.config, deps.pluginHub!, deps.activity, sid, getHeaders),
        })
      : undefined);

  // CORS middleware supporting ChatGPT web and Gemini web
  app.use((req: Request, res: Response, next) => {
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
    } else {
      res.setHeader("Access-Control-Allow-Origin", "*");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS, PUT, PATCH");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, X-Requested-With, Accept, Origin"
    );
    res.setHeader(
      "Access-Control-Expose-Headers",
      "Mcp-Session-Id, Mcp-Protocol-Version, WWW-Authenticate"
    );

    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  // Body parsers: 50 MB limit for JSON, urlencoded for OAuth forms
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ extended: true, limit: "10mb" }));

  // Health endpoint (public, unauthenticated)
  app.get("/health", (_req: Request, res: Response) => {
    res.json({
      ok: true,
      version: deps.config.version,
      uptime: Math.floor(process.uptime()),
    });
  });

  // Mount OAuth 2.1 & metadata endpoints
  app.use(createOAuthRouter(deps.config));

  // MCP auth middleware
  const authMiddleware = createAuthMiddleware(deps.config);

  // MCP endpoints (POST, GET, DELETE /mcp and /mcp/:urlToken)
  const mcpHandler = async (req: Request, res: Response) => {
    try {
      await sessionManager.handleRequest(req, res);
    } catch (err) {
      console.error("[mcp] Error handling request:", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
          id: req.body?.id ?? null,
        });
      }
    }
  };

  // Plugins MCP endpoints (POST, GET, DELETE /mcp/plugins and /mcp/plugins/:urlToken)
  const pluginsHandler = async (req: Request, res: Response) => {
    if (!pluginsSessionManager) {
      res.status(503).json({ error: "Plugin hub is not available" });
      return;
    }
    try {
      await pluginsSessionManager.handleRequest(req, res);
    } catch (err) {
      console.error("[mcp-plugins] Error handling request:", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
          id: req.body?.id ?? null,
        });
      }
    }
  };

  // Mount /mcp/plugins first so it does not match /mcp/:urlToken
  app.all("/mcp/plugins", authMiddleware, pluginsHandler);
  app.all("/mcp/plugins/:urlToken", authMiddleware, pluginsHandler);

  app.all("/mcp", authMiddleware, mcpHandler);
  app.all("/mcp/:urlToken", authMiddleware, mcpHandler);

  return { app, sessionManager, pluginsSessionManager };
}
