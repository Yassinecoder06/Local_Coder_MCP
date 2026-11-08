/**
 * Owned by agy1. OAuth 2.1 data store, persisted in DATA_DIR/oauth.json.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export interface RegisteredClient {
  clientId: string;
  clientSecret?: string;
  clientName?: string;
  redirectUris: string[];
  grantTypes: string[];
  responseTypes: string[];
  tokenEndpointAuthMethod?: string;
  scope?: string;
  createdAt: number;
}

export interface AuthCode {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  scope?: string;
  expiresAt: number;
}

export interface AccessToken {
  accessToken: string;
  clientId: string;
  scope?: string;
  expiresAt: number;
}

export interface RefreshToken {
  refreshToken: string;
  clientId: string;
  accessToken: string;
  scope?: string;
}

interface OAuthData {
  clients: Record<string, RegisteredClient>;
  approvedClients: Record<string, boolean>;
  authCodes: Record<string, AuthCode>;
  tokens: Record<string, AccessToken>;
  refreshTokens: Record<string, RefreshToken>;
}

let storePath: string | null = null;
let data: OAuthData = {
  clients: {},
  approvedClients: {},
  authCodes: {},
  tokens: {},
  refreshTokens: {},
};

export function initOAuthStore(dataDir: string): void {
  storePath = path.join(dataDir, "oauth.json");
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    if (fs.existsSync(storePath)) {
      const raw = fs.readFileSync(storePath, "utf-8");
      const parsed = JSON.parse(raw);
      data = {
        clients: parsed.clients || {},
        approvedClients: parsed.approvedClients || {},
        authCodes: parsed.authCodes || {},
        tokens: parsed.tokens || {},
        refreshTokens: parsed.refreshTokens || {},
      };
      return;
    }
  } catch (err) {
    console.warn("[oauth] Failed to load oauth.json:", err);
  }

  data = {
    clients: {},
    approvedClients: {},
    authCodes: {},
    tokens: {},
    refreshTokens: {},
  };
  persistOAuthStoreSync();
}

function persistOAuthStoreSync(): void {
  if (!storePath) return;
  try {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    const tmp = `${storePath}.tmp.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
    fs.renameSync(tmp, storePath);
  } catch (err) {
    console.error("[oauth] Failed to persist oauth.json:", err);
  }
}

export function registerOAuthClient(params: {
  clientName?: string;
  redirectUris?: string[];
  grantTypes?: string[];
  responseTypes?: string[];
  tokenEndpointAuthMethod?: string;
  scope?: string;
}): RegisteredClient {
  const clientId = `c_${crypto.randomBytes(16).toString("hex")}`;
  const clientSecret = crypto.randomBytes(24).toString("hex");
  const client: RegisteredClient = {
    clientId,
    clientSecret,
    clientName: params.clientName || "MCP Client",
    redirectUris: params.redirectUris || [],
    grantTypes: params.grantTypes || ["authorization_code", "refresh_token"],
    responseTypes: params.responseTypes || ["code"],
    tokenEndpointAuthMethod: params.tokenEndpointAuthMethod || "none",
    scope: params.scope || "mcp",
    createdAt: Date.now(),
  };
  data.clients[clientId] = client;
  persistOAuthStoreSync();
  return client;
}

export function getOAuthClient(clientId: string): RegisteredClient | undefined {
  return data.clients[clientId];
}

export function isClientApproved(clientId: string): boolean {
  return Boolean(data.approvedClients[clientId]);
}

export function setClientApproved(clientId: string, approved = true): void {
  data.approvedClients[clientId] = approved;
  persistOAuthStoreSync();
}

export function createAuthCode(params: {
  clientId: string;
  redirectUri: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  scope?: string;
}): string {
  const code = crypto.randomBytes(24).toString("base64url");
  data.authCodes[code] = {
    code,
    clientId: params.clientId,
    redirectUri: params.redirectUri,
    codeChallenge: params.codeChallenge,
    codeChallengeMethod: params.codeChallengeMethod,
    scope: params.scope,
    expiresAt: Date.now() + 10 * 60 * 1000, // 10 minutes
  };
  persistOAuthStoreSync();
  return code;
}

export function consumeAuthCode(code: string): AuthCode | undefined {
  const record = data.authCodes[code];
  if (!record) return undefined;
  delete data.authCodes[code];
  persistOAuthStoreSync();
  if (record.expiresAt < Date.now()) return undefined;
  return record;
}

export function issueTokens(
  clientId: string,
  scope?: string
): { accessToken: string; refreshToken: string; expiresIn: number } {
  const accessToken = crypto.randomBytes(32).toString("base64url");
  const refreshToken = crypto.randomBytes(32).toString("base64url");
  const expiresIn = 30 * 24 * 60 * 60; // 30 days

  data.tokens[accessToken] = {
    accessToken,
    clientId,
    scope,
    expiresAt: Date.now() + expiresIn * 1000,
  };

  data.refreshTokens[refreshToken] = {
    refreshToken,
    clientId,
    accessToken,
    scope,
  };

  persistOAuthStoreSync();
  return { accessToken, refreshToken, expiresIn };
}

export function refreshAccessToken(refreshTokenStr: string): { accessToken: string; expiresIn: number } | undefined {
  const record = data.refreshTokens[refreshTokenStr];
  if (!record) return undefined;

  // Remove old access token if present
  delete data.tokens[record.accessToken];

  const newAccessToken = crypto.randomBytes(32).toString("base64url");
  const expiresIn = 30 * 24 * 60 * 60; // 30 days

  data.tokens[newAccessToken] = {
    accessToken: newAccessToken,
    clientId: record.clientId,
    scope: record.scope,
    expiresAt: Date.now() + expiresIn * 1000,
  };

  record.accessToken = newAccessToken;
  persistOAuthStoreSync();

  return { accessToken: newAccessToken, expiresIn };
}

export function isValidAccessToken(token: string): boolean {
  const record = data.tokens[token];
  if (!record) return false;
  if (record.expiresAt < Date.now()) {
    delete data.tokens[token];
    persistOAuthStoreSync();
    return false;
  }
  return true;
}

export function invalidateAllOAuthTokens(): void {
  data.tokens = {};
  data.refreshTokens = {};
  data.authCodes = {};
  persistOAuthStoreSync();
}
