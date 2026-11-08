/**
 * Owned by agy1. Authentication middleware for MCP endpoints.
 * Never logs tokens.
 */
import type { Request, Response, NextFunction } from "express";
import type { AppConfig } from "../config.js";
import { isValidAccessToken } from "./oauth-store.js";
import { getEffectiveBaseUrl, getLocalBaseUrl } from "./public-url.js";

export { getEffectiveBaseUrl, getLocalBaseUrl };

export function getBaseUrl(req: Request, config: AppConfig): string {
  if (config.publicUrl) return config.publicUrl.replace(/\/+$/, "");
  const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol || "http";
  const host = (req.headers["x-forwarded-host"] as string) || req.get("host") || `${config.host}:${config.port}`;
  return `${proto}://${host}`;
}

export function createAuthMiddleware(config: AppConfig) {
  return async function authMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (config.authMode === "none") {
      return next();
    }

    // 1. Check URL path token: /mcp/<token>
    const urlToken = (req.params as any)?.urlToken as string | undefined;
    if (urlToken && (config.authMode === "token" || config.authMode === "both")) {
      if (urlToken === config.mcpToken) {
        return next();
      }
    }

    // 2. Check Authorization: Bearer <token>
    const authHeader = req.headers["authorization"] || "";
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (match) {
      const token = match[1].trim();

      // Check against static MCP_TOKEN
      if ((config.authMode === "token" || config.authMode === "both") && token === config.mcpToken) {
        return next();
      }

      // Check against dynamic OAuth access tokens
      if ((config.authMode === "oauth" || config.authMode === "both") && isValidAccessToken(token)) {
        return next();
      }
    }

    // Unauthenticated rejection
    const isOAuthEnabled = config.authMode === "oauth" || config.authMode === "both";
    if (isOAuthEnabled) {
      const baseUrl = await getEffectiveBaseUrl(req, config);
      res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`);
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    res.status(404).json({ error: "Not found" });
  };
}
