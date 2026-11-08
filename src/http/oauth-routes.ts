/**
 * Owned by agy1. OAuth 2.1 endpoints + Dynamic Client Registration + PKCE.
 */
import crypto from "node:crypto";
import express, { Router, type Request, type Response } from "express";
import type { AppConfig } from "../config.js";
import { getBaseUrl } from "./auth-middleware.js";
import {
  consumeAuthCode,
  createAuthCode,
  getOAuthClient,
  isClientApproved,
  issueTokens,
  refreshAccessToken,
  registerOAuthClient,
  setClientApproved,
} from "./oauth-store.js";

function verifyPkce(verifier: string, challenge: string, method = "S256"): boolean {
  if (method === "plain") {
    return verifier === challenge;
  }
  const hash = crypto.createHash("sha256").update(verifier).digest("base64url");
  return hash === challenge;
}

function renderAuthorizeHtml(params: {
  clientId: string;
  clientName: string;
  redirectUri: string;
  state?: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  error?: string;
}): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize Local Coder MCP</title>
  <style>
    :root {
      --bg: #0f172a;
      --card-bg: #1e293b;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --primary: #3b82f6;
      --primary-hover: #2563eb;
      --border: #334155;
      --error: #ef4444;
    }
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--bg);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      color: var(--text);
      padding: 1rem;
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 2rem;
      max-width: 420px;
      width: 100%;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.4);
    }
    h1 {
      font-size: 1.35rem;
      font-weight: 600;
      margin: 0 0 0.5rem 0;
    }
    p {
      color: var(--text-muted);
      font-size: 0.9rem;
      line-height: 1.4;
      margin: 0 0 1.5rem 0;
    }
    .client-badge {
      display: inline-block;
      background: #0f172a;
      border: 1px solid var(--border);
      padding: 0.25rem 0.6rem;
      border-radius: 6px;
      font-weight: 500;
      color: var(--text);
      margin-bottom: 1rem;
    }
    .form-group {
      margin-bottom: 1.25rem;
    }
    label {
      display: block;
      font-size: 0.85rem;
      font-weight: 500;
      margin-bottom: 0.4rem;
    }
    input[type="password"], input[type="text"] {
      width: 100%;
      box-sizing: border-box;
      background: #0f172a;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 0.65rem 0.75rem;
      color: var(--text);
      font-size: 0.95rem;
      outline: none;
      transition: border-color 0.2s;
    }
    input[type="password"]:focus, input[type="text"]:focus {
      border-color: var(--primary);
    }
    .btn {
      width: 100%;
      background: var(--primary);
      color: white;
      border: none;
      border-radius: 6px;
      padding: 0.7rem;
      font-size: 0.95rem;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.2s;
    }
    .btn:hover {
      background: var(--primary-hover);
    }
    .error-msg {
      background: rgba(239, 68, 68, 0.15);
      border: 1px solid var(--error);
      color: #fca5a5;
      padding: 0.6rem 0.75rem;
      border-radius: 6px;
      font-size: 0.85rem;
      margin-bottom: 1rem;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>Authorize Local Coder</h1>
    <p>Allow this client application to access your local coding workspace tools via MCP.</p>
    <div>
      <span class="client-badge">${escapeHtml(params.clientName || params.clientId)}</span>
    </div>
    ${params.error ? `<div class="error-msg">${escapeHtml(params.error)}</div>` : ""}
    <form method="POST" action="/oauth/authorize">
      <input type="hidden" name="client_id" value="${escapeHtml(params.clientId)}">
      <input type="hidden" name="redirect_uri" value="${escapeHtml(params.redirectUri)}">
      <input type="hidden" name="state" value="${escapeHtml(params.state || "")}">
      <input type="hidden" name="code_challenge" value="${escapeHtml(params.codeChallenge || "")}">
      <input type="hidden" name="code_challenge_method" value="${escapeHtml(params.codeChallengeMethod || "S256")}">
      <div class="form-group">
        <label for="access_key">Server Access Key (MCP_TOKEN)</label>
        <input type="password" id="access_key" name="access_key" required placeholder="Enter MCP_TOKEN" autofocus>
      </div>
      <button type="submit" class="btn">Authorize Connection</button>
    </form>
  </div>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str.replace(/[&<>"']/g, (m) => {
    switch (m) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      case "'": return "&#39;";
      default: return m;
    }
  });
}

export function createOAuthRouter(config: AppConfig): Router {
  const router = Router();

  // 1. Authorization server metadata
  router.get("/.well-known/oauth-authorization-server", (req: Request, res: Response) => {
    const baseUrl = getBaseUrl(req, config);
    res.json({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/oauth/authorize`,
      token_endpoint: `${baseUrl}/oauth/token`,
      registration_endpoint: `${baseUrl}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256", "plain"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
      scopes_supported: ["mcp"],
    });
  });

  // 2. Protected resource metadata
  router.get("/.well-known/oauth-protected-resource", (req: Request, res: Response) => {
    const baseUrl = getBaseUrl(req, config);
    res.json({
      resource: `${baseUrl}/mcp`,
      authorization_servers: [baseUrl],
      scopes_supported: ["mcp"],
      bearer_methods_supported: ["header"],
    });
  });

  // 3. Dynamic Client Registration (RFC 7591)
  router.post("/oauth/register", (req: Request, res: Response) => {
    const body = req.body || {};
    const client = registerOAuthClient({
      clientName: body.client_name,
      redirectUris: Array.isArray(body.redirect_uris) ? body.redirect_uris : [],
      grantTypes: Array.isArray(body.grant_types) ? body.grant_types : ["authorization_code", "refresh_token"],
      responseTypes: Array.isArray(body.response_types) ? body.response_types : ["code"],
      tokenEndpointAuthMethod: body.token_endpoint_auth_method || "none",
      scope: body.scope || "mcp",
    });

    res.status(201).json({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      grant_types: client.grantTypes,
      response_types: client.responseTypes,
      token_endpoint_auth_method: client.tokenEndpointAuthMethod,
      scope: client.scope,
    });
  });

  // 4. Authorization endpoint - GET
  router.get("/oauth/authorize", (req: Request, res: Response) => {
    const clientId = (req.query.client_id as string) || "";
    const redirectUri = (req.query.redirect_uri as string) || "";
    const state = req.query.state as string | undefined;
    const codeChallenge = req.query.code_challenge as string | undefined;
    const codeChallengeMethod = (req.query.code_challenge_method as string) || "S256";

    if (!clientId || !redirectUri) {
      res.status(400).send("Missing client_id or redirect_uri");
      return;
    }

    const client = getOAuthClient(clientId);
    const clientName = client?.clientName || clientId;

    // Check if client is already remembered/approved
    if (isClientApproved(clientId)) {
      const code = createAuthCode({
        clientId,
        redirectUri,
        codeChallenge,
        codeChallengeMethod,
      });
      const redirectUrl = new URL(redirectUri);
      redirectUrl.searchParams.set("code", code);
      if (state) redirectUrl.searchParams.set("state", state);
      res.redirect(redirectUrl.toString());
      return;
    }

    // Render approval form
    res.type("html").send(
      renderAuthorizeHtml({
        clientId,
        clientName,
        redirectUri,
        state,
        codeChallenge,
        codeChallengeMethod,
      })
    );
  });

  // 4. Authorization endpoint - POST form submission
  router.post("/oauth/authorize", (req: Request, res: Response) => {
    const { client_id, redirect_uri, state, code_challenge, code_challenge_method, access_key } = req.body || {};

    if (!client_id || !redirect_uri) {
      res.status(400).send("Missing client_id or redirect_uri");
      return;
    }

    const client = getOAuthClient(client_id);
    const clientName = client?.clientName || client_id;

    // Validate access key against MCP_TOKEN
    if (!access_key || access_key !== config.mcpToken) {
      res.status(401).type("html").send(
        renderAuthorizeHtml({
          clientId: client_id,
          clientName,
          redirectUri: redirect_uri,
          state,
          codeChallenge: code_challenge,
          codeChallengeMethod: code_challenge_method,
          error: "Invalid access key. Please verify your MCP_TOKEN.",
        })
      );
      return;
    }

    // Remember approval for this client
    setClientApproved(client_id, true);

    const code = createAuthCode({
      clientId: client_id,
      redirectUri: redirect_uri,
      codeChallenge: code_challenge,
      codeChallengeMethod: code_challenge_method,
    });

    const redirectUrl = new URL(redirect_uri);
    redirectUrl.searchParams.set("code", code);
    if (state) redirectUrl.searchParams.set("state", state);
    res.redirect(redirectUrl.toString());
  });

  // 5. Token endpoint
  router.post("/oauth/token", (req: Request, res: Response) => {
    const grantType = req.body?.grant_type;

    if (grantType === "authorization_code") {
      const { code, client_id, redirect_uri, code_verifier } = req.body || {};
      if (!code) {
        res.status(400).json({ error: "invalid_request", error_description: "Missing code" });
        return;
      }

      const authRecord = consumeAuthCode(code);
      if (!authRecord) {
        res.status(400).json({ error: "invalid_grant", error_description: "Invalid or expired authorization code" });
        return;
      }

      if (redirect_uri && authRecord.redirectUri !== redirect_uri) {
        res.status(400).json({ error: "invalid_grant", error_description: "redirect_uri mismatch" });
        return;
      }

      if (client_id && authRecord.clientId !== client_id) {
        res.status(400).json({ error: "invalid_grant", error_description: "client_id mismatch" });
        return;
      }

      // Verify PKCE
      if (authRecord.codeChallenge) {
        if (!code_verifier || !verifyPkce(code_verifier, authRecord.codeChallenge, authRecord.codeChallengeMethod)) {
          res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed" });
          return;
        }
      }

      const tokens = issueTokens(authRecord.clientId, authRecord.scope);
      res.json({
        access_token: tokens.accessToken,
        token_type: "Bearer",
        expires_in: tokens.expiresIn,
        refresh_token: tokens.refreshToken,
        scope: "mcp",
      });
      return;
    }

    if (grantType === "refresh_token") {
      const { refresh_token } = req.body || {};
      if (!refresh_token) {
        res.status(400).json({ error: "invalid_request", error_description: "Missing refresh_token" });
        return;
      }

      const refreshed = refreshAccessToken(refresh_token);
      if (!refreshed) {
        res.status(400).json({ error: "invalid_grant", error_description: "Invalid or expired refresh token" });
        return;
      }

      res.json({
        access_token: refreshed.accessToken,
        token_type: "Bearer",
        expires_in: refreshed.expiresIn,
        refresh_token,
        scope: "mcp",
      });
      return;
    }

    res.status(400).json({ error: "unsupported_grant_type", error_description: `Unsupported grant_type: ${grantType}` });
  });

  return router;
}
