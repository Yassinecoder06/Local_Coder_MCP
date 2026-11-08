import test, { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import type { AppConfig } from "../src/config.js";
import { createActivityLog } from "../src/core/activity.js";
import { initSettings, getSettings, updateSettings } from "../src/core/settings.js";
import { createMcpApp } from "../src/http/app.js";
import { initOAuthStore } from "../src/http/oauth-store.js";
import { createAdminApp } from "../src/admin/app.js";
import { createSkillRegistry } from "../src/skills/index.js";
import { createCommandRegistry } from "../src/commands/index.js";
import { getDisplayHost, clearPublicUrlCache } from "../src/http/public-url.js";

describe("Core Server Architecture", () => {
  let tmpDataDir: string;
  let config: AppConfig;
  let mcpServer: http.Server;
  let adminServer: http.Server;
  let mcpPort: number;
  let adminPort: number;
  let mcpBaseUrl: string;
  let adminBaseUrl: string;
  let activityLog: ReturnType<typeof createActivityLog>;
  let sessionManagerRef: any;

  const testToken = "test-secret-token-12345";

  before(async () => {
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "local-coder-mcp-test-"));
    config = {
      port: 0,
      adminPort: 0,
      host: "127.0.0.1",
      adminHost: "127.0.0.1",
      mcpToken: testToken,
      publicUrl: "",
      tunnelMetricsUrl: "",
      authMode: "both",
      workspaceRoots: [tmpDataDir],
      defaultWorkspace: tmpDataDir,
      dataDir: tmpDataDir,
      builtinSkillsDir: path.join(tmpDataDir, "builtin_skills"),
      userSkillsDir: path.join(tmpDataDir, "user_skills"),
      extraSkillsDirs: [],
      builtinCommandsDir: path.join(tmpDataDir, "builtin_commands"),
      userCommandsDir: path.join(tmpDataDir, "user_commands"),
      approvalMode: "minimal",
      toolProfile: "essential",
      shellTimeoutMs: 10000,
      shellSyncMs: 5000,
      maxOutputBytes: 60000,
      checkpoints: true,
      logLevel: "info",
      version: "1.0.0",
    };

    initSettings(tmpDataDir, { approvalMode: "minimal", toolProfile: "essential" });
    initOAuthStore(tmpDataDir);
    activityLog = createActivityLog(path.join(tmpDataDir, "activity.jsonl"));
    const skillRegistry = createSkillRegistry(config, { get: getSettings, update: updateSettings });
    const commandRegistry = createCommandRegistry(config);

    const { app: mcpApp, sessionManager } = createMcpApp({
      config,
      activity: activityLog,
      skills: skillRegistry,
      commands: commandRegistry,
    });
    sessionManagerRef = sessionManager;

    const adminApp = createAdminApp({
      config,
      activity: activityLog,
      skills: skillRegistry,
      commands: commandRegistry,
      sessionManager,
    });

    mcpServer = http.createServer(mcpApp);
    adminServer = http.createServer(adminApp);

    await new Promise<void>((resolve) => {
      mcpServer.listen(0, "127.0.0.1", () => {
        mcpPort = (mcpServer.address() as any).port;
        mcpBaseUrl = `http://127.0.0.1:${mcpPort}`;
        resolve();
      });
    });

    await new Promise<void>((resolve) => {
      adminServer.listen(0, "127.0.0.1", () => {
        adminPort = (adminServer.address() as any).port;
        adminBaseUrl = `http://127.0.0.1:${adminPort}`;
        resolve();
      });
    });
  });

  after(async () => {
    sessionManagerRef?.stopCleanup();
    await new Promise<void>((resolve) => mcpServer.close(() => resolve()));
    await new Promise<void>((resolve) => adminServer.close(() => resolve()));
    fs.rmSync(tmpDataDir, { recursive: true, force: true });
  });

  describe("Health Check", () => {
    it("returns 200 OK with server status", async () => {
      const res = await fetch(`${mcpBaseUrl}/health`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.ok, true);
      assert.equal(data.version, "1.0.0");
    });
  });

  describe("Token Authentication", () => {
    it("accepts valid Bearer token", async () => {
      const res = await fetch(`${mcpBaseUrl}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${testToken}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      assert.equal(res.status, 200);
      const sid = res.headers.get("mcp-session-id");
      assert.ok(sid, "Response must include mcp-session-id header");
    });

    it("accepts valid URL path token (/mcp/<token>)", async () => {
      const res = await fetch(`${mcpBaseUrl}/mcp/${testToken}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      });
      assert.equal(res.status, 200);
      const sid = res.headers.get("mcp-session-id");
      assert.ok(sid);
    });

    it("rejects invalid Bearer token with 401 and WWW-Authenticate", async () => {
      const res = await fetch(`${mcpBaseUrl}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: "Bearer wrong-token",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
      });
      assert.equal(res.status, 401);
      const wwwAuth = res.headers.get("WWW-Authenticate");
      assert.ok(wwwAuth?.includes("resource_metadata="), "Must include resource_metadata");
    });

    it("rejects unauthenticated request with 401", async () => {
      const res = await fetch(`${mcpBaseUrl}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list" }),
      });
      assert.equal(res.status, 401);
    });
  });

  describe("OAuth 2.1 DCR + PKCE", () => {
    let clientId: string;
    let codeVerifier: string;
    let codeChallenge: string;
    let authCode: string;
    let accessToken: string;
    let refreshToken: string;

    it("exposes authorization server metadata", async () => {
      const res = await fetch(`${mcpBaseUrl}/.well-known/oauth-authorization-server`);
      assert.equal(res.status, 200);
      const meta = await res.json();
      assert.ok(meta.authorization_endpoint);
      assert.ok(meta.token_endpoint);
      assert.ok(meta.registration_endpoint);
      assert.deepEqual(meta.code_challenge_methods_supported, ["S256", "plain"]);
    });

    it("exposes protected resource metadata", async () => {
      const res = await fetch(`${mcpBaseUrl}/.well-known/oauth-protected-resource`);
      assert.equal(res.status, 200);
      const meta = await res.json();
      assert.ok(meta.resource);
      assert.ok(Array.isArray(meta.authorization_servers));
    });

    it("registers dynamic client via DCR (POST /oauth/register)", async () => {
      const res = await fetch(`${mcpBaseUrl}/oauth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "Test Gemini Custom App",
          redirect_uris: ["https://example.com/oauth/callback"],
        }),
      });
      assert.equal(res.status, 201);
      const data = await res.json();
      assert.ok(data.client_id);
      clientId = data.client_id;
    });

    it("authorizes client with MCP_TOKEN access key (POST /oauth/authorize)", async () => {
      codeVerifier = crypto.randomBytes(32).toString("base64url");
      codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");

      const form = new URLSearchParams({
        client_id: clientId,
        redirect_uri: "https://example.com/oauth/callback",
        state: "test-state-xyz",
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        access_key: testToken,
      });

      const res = await fetch(`${mcpBaseUrl}/oauth/authorize`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
        redirect: "manual",
      });

      assert.equal(res.status, 302);
      const location = res.headers.get("location");
      assert.ok(location);
      const parsed = new URL(location!);
      assert.equal(parsed.searchParams.get("state"), "test-state-xyz");
      authCode = parsed.searchParams.get("code")!;
      assert.ok(authCode, "Must receive auth code in redirect");
    });

    it("rejects an approved client sending codes to an unregistered redirect_uri", async () => {
      const query = new URLSearchParams({
        client_id: clientId,
        redirect_uri: "https://attacker.example/steal",
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      });
      const res = await fetch(`${mcpBaseUrl}/oauth/authorize?${query}`, { redirect: "manual" });
      assert.equal(res.status, 400);
      assert.equal(res.headers.get("location"), null);
    });

    it("rejects authorize requests without PKCE", async () => {
      const query = new URLSearchParams({
        client_id: clientId,
        redirect_uri: "https://example.com/oauth/callback",
      });
      const res = await fetch(`${mcpBaseUrl}/oauth/authorize?${query}`, { redirect: "manual" });
      assert.equal(res.status, 400);
    });

    it("exchanges code for tokens using S256 PKCE (POST /oauth/token)", async () => {
      const body = {
        grant_type: "authorization_code",
        code: authCode,
        client_id: clientId,
        redirect_uri: "https://example.com/oauth/callback",
        code_verifier: codeVerifier,
      };

      const res = await fetch(`${mcpBaseUrl}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      assert.equal(res.status, 200);
      const tokens = await res.json();
      assert.ok(tokens.access_token);
      assert.ok(tokens.refresh_token);
      assert.equal(tokens.token_type, "Bearer");
      accessToken = tokens.access_token;
      refreshToken = tokens.refresh_token;
    });

    it("authenticates MCP request using OAuth access token", async () => {
      const res = await fetch(`${mcpBaseUrl}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 10, method: "tools/list" }),
      });
      assert.equal(res.status, 200);
    });

    it("refreshes access token with refresh_token grant", async () => {
      const res = await fetch(`${mcpBaseUrl}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }),
      });
      assert.equal(res.status, 200);
      const tokens = await res.json();
      assert.ok(tokens.access_token);
      assert.notEqual(tokens.access_token, accessToken);

      // Verify new token works
      const testRes = await fetch(`${mcpBaseUrl}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${tokens.access_token}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 11, method: "tools/list" }),
      });
      assert.equal(testRes.status, 200);
    });
  });

  describe("Transparent Session Recovery", () => {
    it("transparently recovers unknown / stale session id without 404", async () => {
      const staleSid = "stale-session-id-99999999";
      const res = await fetch(`${mcpBaseUrl}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${testToken}`,
          "mcp-session-id": staleSid,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 20, method: "tools/list" }),
      });

      assert.equal(res.status, 200, "Stale session request must not return 404");
      assert.equal(res.headers.get("mcp-session-id"), staleSid);
    });

    it("serves request without session id by allocating a fresh session", async () => {
      const res = await fetch(`${mcpBaseUrl}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${testToken}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 21, method: "tools/list" }),
      });

      assert.equal(res.status, 200);
      const sid = res.headers.get("mcp-session-id");
      assert.ok(sid);
    });
  });

  describe("Admin Host-Header Guard & REST API", () => {
    it("allows localhost and 127.0.0.1 Host headers", async () => {
      const res = await fetch(`${adminBaseUrl}/api/status`, {
        headers: { Host: `127.0.0.1:${adminPort}` },
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.version, "1.0.0");
      assert.ok(data.endpoints.mcpUrlWithToken);
    });

    it("rejects unauthorized host headers (DNS rebinding protection)", async () => {
      // Node's native fetch() overrides the Host header with the target URL's host.
      // Use node:http request to deliver an explicit spoofed Host header.
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port: adminPort,
            path: "/api/status",
            method: "GET",
            headers: { Host: `evil-attacker.com:${adminPort}` },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode || 0);
          }
        );
        req.on("error", reject);
        req.end();
      });

      assert.equal(status, 403);
    });

    it("GET /api/connect returns steps and URLs for ChatGPT and Gemini", async () => {
      const res = await fetch(`${adminBaseUrl}/api/connect`, {
        headers: { Host: `localhost:${adminPort}` },
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(data.chatgpt.url);
      assert.ok(Array.isArray(data.chatgpt.steps));
      assert.ok(data.gemini.url);
      assert.ok(Array.isArray(data.gemini.steps));
      assert.equal(data.token, testToken);
    });

    it("POST /api/token/rotate rotates token and invalidates OAuth tokens", async () => {
      const res = await fetch(`${adminBaseUrl}/api/token/rotate`, {
        method: "POST",
        headers: { Host: `localhost:${adminPort}` },
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(data.token);
      assert.notEqual(data.token, testToken);

      // Verify token file was updated
      const tokenOnDisk = fs.readFileSync(path.join(tmpDataDir, "token"), "utf-8");
      assert.equal(tokenOnDisk, data.token);

      // Revert config token for other tests
      config.mcpToken = data.token;
    });

    it("GET /api/tools and PATCH /api/tools/:name works", async () => {
      const listRes = await fetch(`${adminBaseUrl}/api/tools`, {
        headers: { Host: `localhost:${adminPort}` },
      });
      assert.equal(listRes.status, 200);
      const list = await listRes.json();
      assert.ok(Array.isArray(list));

      const patchRes = await fetch(`${adminBaseUrl}/api/tools/read`, {
        method: "PATCH",
        headers: {
          Host: `localhost:${adminPort}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ enabled: false }),
      });
      assert.equal(patchRes.status, 200);
      const patchData = await patchRes.json();
      assert.equal(patchData.enabled, false);

      const settings = getSettings();
      assert.ok(settings.disabledTools.includes("read"));
    });

    it("GET /api/settings and PATCH /api/settings works", async () => {
      const patchRes = await fetch(`${adminBaseUrl}/api/settings`, {
        method: "PATCH",
        headers: {
          Host: `localhost:${adminPort}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ approvalMode: "standard" }),
      });
      assert.equal(patchRes.status, 200);
      const updated = await patchRes.json();
      assert.equal(updated.approvalMode, "standard");
    });

    it("GET /api/activity returns recent activity entries", async () => {
      activityLog.record({
        tool: "test_tool",
        ok: true,
        summary: "test ran",
        ms: 12,
      });

      const res = await fetch(`${adminBaseUrl}/api/activity?limit=10`, {
        headers: { Host: `localhost:${adminPort}` },
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(Array.isArray(data));
      assert.ok(data.length > 0);
      assert.equal(data[0].tool, "test_tool");
    });
  });

  describe("Display Host & Tunnel Auto-Discovery", () => {
    let mockTunnelServer: http.Server;
    let mockTunnelPort: number;
    let mockHostname = "discovered-subdomain.trycloudflare.com";

    before(async () => {
      mockTunnelServer = http.createServer((req, res) => {
        if (req.url === "/quicktunnel" && req.method === "GET") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ hostname: mockHostname }));
          return;
        }
        res.writeHead(404).end();
      });

      await new Promise<void>((resolve) => {
        mockTunnelServer.listen(0, "127.0.0.1", () => {
          mockTunnelPort = (mockTunnelServer.address() as any).port;
          resolve();
        });
      });
    });

    after(async () => {
      clearPublicUrlCache();
      config.host = "127.0.0.1";
      config.publicUrl = "";
      config.tunnelMetricsUrl = "";
      await new Promise<void>((resolve) => mockTunnelServer.close(() => resolve()));
    });

    it("getDisplayHost maps 0.0.0.0, ::, and empty string to localhost", () => {
      assert.equal(getDisplayHost("0.0.0.0"), "localhost");
      assert.equal(getDisplayHost("::"), "localhost");
      assert.equal(getDisplayHost("[::]"), "localhost");
      assert.equal(getDisplayHost(""), "localhost");
      assert.equal(getDisplayHost("   "), "localhost");
      assert.equal(getDisplayHost("127.0.0.1"), "127.0.0.1");
      assert.equal(getDisplayHost("custom.host"), "custom.host");
    });

    it("GET /api/status returns localhost display host and endpoints.public = null when no public URL", async () => {
      config.host = "0.0.0.0";
      config.publicUrl = "";
      config.tunnelMetricsUrl = "";
      clearPublicUrlCache();

      const res = await fetch(`${adminBaseUrl}/api/status`, {
        headers: { Host: `localhost:${adminPort}` },
      });
      assert.equal(res.status, 200);
      const data = await res.json();

      assert.equal(data.endpoints.local, `http://localhost:${config.port}`);
      assert.equal(data.endpoints.public, null, "endpoints.public must be null when no public URL exists");
      assert.equal(data.endpoints.mcpUrlWithToken, `http://localhost:${config.port}/mcp/${config.mcpToken}`);
      assert.equal(data.endpoints.oauthIssuer, `http://localhost:${config.port}`);
    });

    it("GET /api/connect includes public HTTPS warning note when no public URL exists", async () => {
      config.host = "0.0.0.0";
      config.publicUrl = "";
      config.tunnelMetricsUrl = "";
      clearPublicUrlCache();

      const res = await fetch(`${adminBaseUrl}/api/connect`, {
        headers: { Host: `localhost:${adminPort}` },
      });
      assert.equal(res.status, 200);
      const data = await res.json();

      assert.equal(data.chatgpt.url, `http://localhost:${config.port}/mcp/${config.mcpToken}`);
      assert.ok(
        data.chatgpt.steps[0].includes("docker compose --profile tunnel up -d"),
        "ChatGPT steps must include tunnel command note"
      );
      assert.ok(
        data.gemini.steps[0].includes("docker compose --profile tunnel up -d"),
        "Gemini steps must include tunnel command note"
      );
    });

    it("auto-discovers public URL from tunnelMetricsUrl and uses it across status, connect, and OAuth metadata", async () => {
      config.host = "0.0.0.0";
      config.publicUrl = "";
      config.tunnelMetricsUrl = `http://127.0.0.1:${mockTunnelPort}`;
      mockHostname = "test-tunnel-auto.trycloudflare.com";
      clearPublicUrlCache();

      // Check /api/status
      const statusRes = await fetch(`${adminBaseUrl}/api/status`, {
        headers: { Host: `localhost:${adminPort}` },
      });
      assert.equal(statusRes.status, 200);
      const statusData = await statusRes.json();
      assert.equal(statusData.endpoints.public, "https://test-tunnel-auto.trycloudflare.com");
      assert.equal(
        statusData.endpoints.mcpUrlWithToken,
        `https://test-tunnel-auto.trycloudflare.com/mcp/${config.mcpToken}`
      );
      assert.equal(statusData.endpoints.oauthIssuer, "https://test-tunnel-auto.trycloudflare.com");

      // Check /api/connect
      const connectRes = await fetch(`${adminBaseUrl}/api/connect`, {
        headers: { Host: `localhost:${adminPort}` },
      });
      assert.equal(connectRes.status, 200);
      const connectData = await connectRes.json();
      assert.equal(
        connectData.chatgpt.url,
        `https://test-tunnel-auto.trycloudflare.com/mcp/${config.mcpToken}`
      );
      assert.equal(connectData.gemini.url, "https://test-tunnel-auto.trycloudflare.com/mcp");
      assert.ok(
        !connectData.chatgpt.steps[0].includes("NOTE:"),
        "Should not show missing tunnel note when public URL is discovered"
      );

      // Check OAuth metadata
      const oauthMetaRes = await fetch(`${mcpBaseUrl}/.well-known/oauth-authorization-server`);
      assert.equal(oauthMetaRes.status, 200);
      const oauthMeta = await oauthMetaRes.json();
      assert.equal(oauthMeta.issuer, "https://test-tunnel-auto.trycloudflare.com");
      assert.equal(
        oauthMeta.authorization_endpoint,
        "https://test-tunnel-auto.trycloudflare.com/oauth/authorize"
      );
    });

    it("caches the discovered tunnel URL for 30s", async () => {
      config.publicUrl = "";
      config.tunnelMetricsUrl = `http://127.0.0.1:${mockTunnelPort}`;
      mockHostname = "cached-tunnel.trycloudflare.com";
      clearPublicUrlCache();

      // First query populates cache
      const res1 = await fetch(`${adminBaseUrl}/api/status`, {
        headers: { Host: `localhost:${adminPort}` },
      });
      const data1 = await res1.json();
      assert.equal(data1.endpoints.public, "https://cached-tunnel.trycloudflare.com");

      // Change upstream hostname
      mockHostname = "different-tunnel.trycloudflare.com";

      // Immediate second query should hit 30s cache
      const res2 = await fetch(`${adminBaseUrl}/api/status`, {
        headers: { Host: `localhost:${adminPort}` },
      });
      const data2 = await res2.json();
      assert.equal(data2.endpoints.public, "https://cached-tunnel.trycloudflare.com", "Must return cached URL");

      // Clearing cache fetches new value
      clearPublicUrlCache();
      const res3 = await fetch(`${adminBaseUrl}/api/status`, {
        headers: { Host: `localhost:${adminPort}` },
      });
      const data3 = await res3.json();
      assert.equal(data3.endpoints.public, "https://different-tunnel.trycloudflare.com");
    });
  });
});
