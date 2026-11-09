import test, { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAdminApp } from "../src/admin/app.js";
import { createMcpApp } from "../src/http/app.js";
import { createPluginHub } from "../src/plugins/hub.js";
import { createMemoryActivityLog } from "../src/core/activity.js";
import { createSkillRegistry } from "../src/skills/index.js";
import { createCommandRegistry } from "../src/commands/index.js";
import { initSettings } from "../src/core/settings.js";
import { MASKED } from "../src/core/plugins.js";
import type { AppConfig } from "../src/config.js";

const FIXTURE_ECHO = fileURLToPath(new URL("./fixtures/echo-mcp.mjs", import.meta.url));

describe("Plugins Hub and /mcp/plugins Endpoint", () => {
  let tmpDir: string;
  let config: AppConfig;
  let hub: ReturnType<typeof createPluginHub>;
  let activity: ReturnType<typeof createMemoryActivityLog>;
  let adminServer: http.Server;
  let mcpServer: http.Server;
  let adminBaseUrl: string;
  let mcpBaseUrl: string;
  let sessionManagerRef: any;
  let pluginsSessionManagerRef: any;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugins-hub-test-"));
    config = {
      port: 8787,
      hostPort: 8787,
      adminPort: 8788,
      host: "127.0.0.1",
      adminHost: "127.0.0.1",
      mcpToken: "test-plugin-token",
      publicUrl: "",
      tunnelMetricsUrl: "",
      authMode: "token",
      workspaceRoots: [tmpDir],
      defaultWorkspace: tmpDir,
      dataDir: tmpDir,
      builtinSkillsDir: path.join(tmpDir, "skills"),
      userSkillsDir: path.join(tmpDir, "user_skills"),
      extraSkillsDirs: [],
      builtinCommandsDir: path.join(tmpDir, "commands"),
      userCommandsDir: path.join(tmpDir, "user_commands"),
      approvalMode: "standard",
      toolProfile: "essential",
      shellTimeoutMs: 10000,
      shellSyncMs: 5000,
      maxOutputBytes: 60000,
      checkpoints: true,
      logLevel: "info",
      version: "1.0.0",
    };

    initSettings(tmpDir, { approvalMode: "standard", toolProfile: "essential" });
    activity = createMemoryActivityLog();
    const skills = createSkillRegistry(config, {
      get: () => ({ disabledTools: [], disabledSkills: [] }),
      update: async () => ({ disabledTools: [], disabledSkills: [] }),
    });
    const commands = createCommandRegistry(config);
    hub = createPluginHub(config);
    await hub.start();

    const { app: mcpApp, sessionManager, pluginsSessionManager } = createMcpApp({
      config,
      activity,
      skills,
      commands,
      pluginHub: hub,
    });
    sessionManagerRef = sessionManager;
    pluginsSessionManagerRef = pluginsSessionManager;

    const adminApp = createAdminApp({
      config,
      activity,
      skills,
      commands,
      sessionManager,
      pluginHub: hub,
    });

    mcpServer = http.createServer(mcpApp);
    adminServer = http.createServer(adminApp);

    await new Promise<void>((resolve) => {
      mcpServer.listen(0, "127.0.0.1", () => {
        const port = (mcpServer.address() as any).port;
        mcpBaseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });

    await new Promise<void>((resolve) => {
      adminServer.listen(0, "127.0.0.1", () => {
        const port = (adminServer.address() as any).port;
        adminBaseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  after(async () => {
    sessionManagerRef?.stopCleanup();
    pluginsSessionManagerRef?.stopCleanup();
    await hub.stop();
    mcpServer.closeAllConnections?.();
    adminServer.closeAllConnections?.();
    await new Promise<void>((resolve) => mcpServer.close(() => resolve()));
    await new Promise<void>((resolve) => adminServer.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("adds echo-mcp fixture, reaches ready, and lists tools with annotations", async () => {
    const res = await fetch(`${adminBaseUrl}/api/plugins`, {
      method: "POST",
      headers: { host: "localhost", "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "echo-plugin",
        name: "Echo Plugin",
        transport: {
          type: "stdio",
          command: "node",
          args: [FIXTURE_ECHO],
          env: { TEST_SECRET: "super-secret-value-123" },
        },
      }),
    });

    assert.equal(res.status, 201);
    const summary = await res.json();
    assert.equal(summary.id, "echo-plugin");
    assert.equal(summary.status.state, "ready");
    assert.equal(summary.status.toolCount, 2);
    assert.equal(summary.status.publishedCount, 2);

    // Verify secret is masked in API response
    assert.equal(summary.transport.env.TEST_SECRET, MASKED);

    // Verify tools published on the hub
    const tools = hub.publishedTools();
    assert.equal(tools.length, 2);
    const echoTool = tools.find((t) => t.name === "echo");
    const addTool = tools.find((t) => t.name === "add");
    assert.ok(echoTool);
    assert.ok(addTool);
    assert.equal(addTool.annotations?.readOnlyHint, true);
  });

  it("calls echo through the /mcp/plugins endpoint and records activity with <plugin>/<tool>", async () => {
    // 1. Initialize MCP session on /mcp/plugins
    const initRes = await fetch(`${mcpBaseUrl}/mcp/plugins`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.mcpToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
      }),
    });

    assert.equal(initRes.status, 200);
    const sid = initRes.headers.get("mcp-session-id");
    assert.ok(sid, "Must return an Mcp-Session-Id");

    // 2. Call tools/call on the /mcp/plugins endpoint
    const callRes = await fetch(`${mcpBaseUrl}/mcp/plugins`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.mcpToken}`,
        "Content-Type": "application/json",
        "Mcp-Session-Id": sid,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "echo",
          arguments: { message: "Hello Plugins!" },
        },
      }),
    });

    assert.equal(callRes.status, 200);
    const callBody = await callRes.json();
    assert.equal(callBody.id, 2);
    assert.ok(Array.isArray(callBody.result?.content));
    assert.equal(callBody.result.content[0].text, "echo: Hello Plugins!");

    // 3. Verify activity entry has tool '<plugin>/<tool>'
    const recent = activity.recent(10);
    const entry = recent.find((e) => e.tool === "echo-plugin/echo");
    assert.ok(entry, "Activity must record entry with tool name 'echo-plugin/echo'");
    assert.equal(entry.client, "test-client");
    assert.equal(entry.ok, true);
  });

  it("disables a tool: tool is not published and list_changed is triggered", async () => {
    let listChangedFired = false;
    const unsub = hub.subscribe(() => {
      listChangedFired = true;
    });

    // Disable 'add' tool
    const patchRes = await fetch(`${adminBaseUrl}/api/plugins/echo-plugin/tools/add`, {
      method: "PATCH",
      headers: { host: "localhost", "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });

    assert.equal(patchRes.status, 200);
    const toolResult = await patchRes.json();
    assert.equal(toolResult.enabled, false);
    assert.equal(toolResult.published, false);
    assert.equal(toolResult.reason, "disabled");

    // Published tools should now only contain 'echo'
    const published = hub.publishedTools();
    assert.equal(published.length, 1);
    assert.equal(published[0].name, "echo");
    assert.ok(listChangedFired, "Hub change listener fired");

    unsub();
  });

  it("detects conflict between two plugins declaring the same tool name", async () => {
    // Add a second plugin also providing 'echo'
    const res = await fetch(`${adminBaseUrl}/api/plugins`, {
      method: "POST",
      headers: { host: "localhost", "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "second-plugin",
        name: "Second Plugin",
        transport: {
          type: "stdio",
          command: "node",
          args: [FIXTURE_ECHO],
        },
      }),
    });

    assert.equal(res.status, 201);

    // Both plugins declare 'echo', so 'echo' must be excluded from publishedTools due to conflict
    const published = hub.publishedTools();
    const publishedEcho = published.find((t) => t.name === "echo");
    assert.equal(publishedEcho, undefined, "Conflicting tool 'echo' must not be published");

    // Detail of echo-plugin should show reason 'conflict' for echo
    const detail = hub.get("echo-plugin");
    const echoTool = detail?.tools.find((t) => t.name === "echo");
    assert.ok(echoTool);
    assert.equal(echoTool.published, false);
    assert.equal(echoTool.reason, "conflict");
  });

  it("preserves stored secret when updating with MASKED placeholder", async () => {
    // Read raw plugins.json on disk to verify stored secret
    const pluginsJsonPath = path.join(tmpDir, "plugins.json");
    const onDisk1 = JSON.parse(fs.readFileSync(pluginsJsonPath, "utf-8"));
    const storedSecret = onDisk1.plugins.find((p: any) => p.id === "echo-plugin").transport.env.TEST_SECRET;
    assert.equal(storedSecret, "super-secret-value-123");

    // Send update where TEST_SECRET is MASKED
    const updateRes = await fetch(`${adminBaseUrl}/api/plugins/echo-plugin`, {
      method: "PATCH",
      headers: { host: "localhost", "Content-Type": "application/json" },
      body: JSON.stringify({
        transport: {
          type: "stdio",
          command: "node",
          args: [FIXTURE_ECHO],
          env: {
            TEST_SECRET: MASKED,
            NEW_VAR: "added-value",
          },
        },
      }),
    });

    assert.equal(updateRes.status, 200);

    // Verify stored file on disk preserved original secret
    const onDisk2 = JSON.parse(fs.readFileSync(pluginsJsonPath, "utf-8"));
    const p = onDisk2.plugins.find((p: any) => p.id === "echo-plugin");
    assert.equal(p.transport.env.TEST_SECRET, "super-secret-value-123");
    assert.equal(p.transport.env.NEW_VAR, "added-value");
  });

  it("rejects insecure external non-loopback HTTP URLs", async () => {
    const res = await fetch(`${adminBaseUrl}/api/plugins`, {
      method: "POST",
      headers: { host: "localhost", "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Insecure Remote Plugin",
        transport: {
          type: "http",
          url: "http://example.com/mcp",
        },
      }),
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.error?.includes("Only HTTPS or loopback HTTP allowed"));
  });

  it("handles crashing commands gracefully by setting state error with useful message", async () => {
    const res = await fetch(`${adminBaseUrl}/api/plugins`, {
      method: "POST",
      headers: { host: "localhost", "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "crashing-plugin",
        name: "Crashing Plugin",
        transport: {
          type: "stdio",
          command: "node",
          args: ["-e", "console.error('CRITICAL: database connection failed'); process.exit(1);"],
        },
      }),
    });

    assert.equal(res.status, 201);
    const summary = await res.json();
    assert.equal(summary.id, "crashing-plugin");
    assert.equal(summary.status.state, "error");
    assert.ok(summary.status.error?.includes("CRITICAL: database connection failed"));
  });

  it("GET /api/status includes pluginsUrlWithToken and GET /api/connect includes plugins url", async () => {
    const statusRes = await fetch(`${adminBaseUrl}/api/status`, {
      headers: { host: "localhost" },
    });
    assert.equal(statusRes.status, 200);
    const statusBody = await statusRes.json();
    assert.ok(statusBody.endpoints.pluginsUrlWithToken?.includes("/mcp/plugins/test-plugin-token"));

    const connectRes = await fetch(`${adminBaseUrl}/api/connect`, {
      headers: { host: "localhost" },
    });
    assert.equal(connectRes.status, 200);
    const connectBody = await connectRes.json();
    assert.ok(connectBody.plugins?.url?.includes("/mcp/plugins/test-plugin-token"));
  });
});

test("pluginBaseEnv falls back to DATA_DIR/cache when HOME is not writable", async () => {
  const os = await import("node:os");
  const fsp = await import("node:fs/promises");
  const pth = await import("node:path");
  const { pluginBaseEnv } = await import("../src/plugins/hub.js");
  const dir = await fsp.mkdtemp(pth.join(os.tmpdir(), "penv-"));
  try {
    const env = pluginBaseEnv(dir, { HOME: "/root-owned", PATH: "/usr/bin", CHROMIUM_PATH: "/usr/local/bin/chromium" }, (d) => d.startsWith(dir));
    assert.equal(env.HOME, pth.join(dir, "cache", "home"));
    assert.equal(env.npm_config_cache, pth.join(dir, "cache", "npm"));
    assert.equal(env.UV_CACHE_DIR, pth.join(dir, "cache", "uv"));
    assert.equal(env.CHROMIUM_PATH, "/usr/local/bin/chromium");
    await fsp.access(pth.join(dir, "cache", "npm"));
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
