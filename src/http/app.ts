/**
 * Owned by agy1. Express application for the MCP server listener (PORT 8787).
 */
import express, { type Express, type Request, type Response } from "express";
import type { AppConfig } from "../config.js";
import type { ActivityLog } from "../core/activity.js";
import type { Board } from "../core/board.js";
import type { CommandRegistry } from "../commands/registry.js";
import type { SkillRegistry } from "../skills/registry.js";
import { createAuthMiddleware } from "./auth-middleware.js";
import { createOAuthRouter } from "./oauth-routes.js";
import { SessionManager } from "./session-manager.js";

export interface McpAppDependencies {
  config: AppConfig;
  activity: ActivityLog;
  skills: SkillRegistry;
  commands: CommandRegistry;
  sessionManager?: SessionManager;
  board?: Board;
}

export function createMcpApp(deps: McpAppDependencies): { app: Express; sessionManager: SessionManager } {
  const app = express();
  const sessionManager = deps.sessionManager ?? new SessionManager(deps);

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

  app.all("/mcp", authMiddleware, mcpHandler);
  app.all("/mcp/:urlToken", authMiddleware, mcpHandler);

  return { app, sessionManager };
}
