#!/usr/bin/env node
/**
 * Owned by agy1. Main server entrypoint.
 * Starts two listeners:
 *  - PORT (8787): MCP server (Streamable HTTP, OAuth 2.1, DCR)
 *  - ADMIN_PORT (8788): Admin UI & REST API (bound to 127.0.0.1)
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { loadConfig } from "./config.js";
import { createActivityLog } from "./core/activity.js";
import { createBoard } from "./core/board.js";
import { createPluginHub } from "./plugins/hub.js";
import { buildPluginsInstructions } from "./mcp/plugins-server.js";
import { initSettings, getSettings, updateSettings } from "./core/settings.js";
import { createAdminApp } from "./admin/app.js";
import { createMcpApp } from "./http/app.js";
import { initOAuthStore } from "./http/oauth-store.js";
import { createSkillRegistry } from "./skills/index.js";
import { createCommandRegistry } from "./commands/index.js";
import { getDisplayHost } from "./http/public-url.js";

async function main() {
  const config = loadConfig();

  // 1. Ensure DATA_DIR exists
  fs.mkdirSync(config.dataDir, { recursive: true });

  // 2. Load or generate MCP_TOKEN in DATA_DIR/token if empty
  const tokenFile = path.join(config.dataDir, "token");
  if (!config.mcpToken) {
    if (fs.existsSync(tokenFile)) {
      config.mcpToken = fs.readFileSync(tokenFile, "utf-8").trim();
    }
    if (!config.mcpToken) {
      config.mcpToken = crypto.randomBytes(24).toString("hex");
      fs.writeFileSync(tokenFile, config.mcpToken, { encoding: "utf-8", mode: 0o600 });
      console.log(`[local-coder-mcp] Generated new MCP_TOKEN in ${tokenFile}`);
    }
  }

  // 3. Initialize persisted settings and OAuth store
  initSettings(config.dataDir, {
    approvalMode: config.approvalMode,
    toolProfile: config.toolProfile,
  });
  initOAuthStore(config.dataDir);

  // 3b. Create board for user requests, finish reports, and live plan events
  const board = createBoard(config.dataDir);

  // 3c. Create and start external MCP plugins hub
  const pluginHub = createPluginHub(config);
  await pluginHub.start();

  // 4. Initialize activity log
  const activityLog = createActivityLog(path.join(config.dataDir, "activity.jsonl"));

  // 5. Build skill & command registries
  const skillRegistry = createSkillRegistry(config, { get: getSettings, update: updateSettings });
  const commandRegistry = createCommandRegistry(config);

  // 6. Create MCP Express app & Session Manager
  const { app: mcpApp, sessionManager, pluginsSessionManager } = createMcpApp({
    config,
    activity: activityLog,
    skills: skillRegistry,
    commands: commandRegistry,
    board,
    pluginHub,
  });
  sessionManager.startCleanup();
  pluginsSessionManager?.startCleanup();

  if (pluginsSessionManager) {
    pluginHub.subscribe(() => {
      pluginsSessionManager.notifyToolListChanged(buildPluginsInstructions(pluginHub));
    });
  }

  // 7. Create Admin Express app
  const adminApp = createAdminApp({
    config,
    activity: activityLog,
    skills: skillRegistry,
    commands: commandRegistry,
    sessionManager,
    board,
    pluginHub,
  });

  // 8. Start HTTP listeners
  const mcpServer = http.createServer(mcpApp);
  const adminServer = http.createServer(adminApp);

  await new Promise<void>((resolve, reject) => {
    mcpServer.listen(config.port, config.host, () => {
      const displayHost = getDisplayHost(config.host);
      console.log(`[local-coder-mcp] MCP server listening on http://${displayHost}:${config.hostPort}`);
      resolve();
    });
    mcpServer.once("error", reject);
  });

  await new Promise<void>((resolve, reject) => {
    adminServer.listen(config.adminPort, config.adminHost, () => {
      const displayAdminHost = getDisplayHost(config.adminHost);
      console.log(`[local-coder-mcp] Admin UI listening on http://${displayAdminHost}:${config.adminPort}`);
      resolve();
    });
    adminServer.once("error", reject);
  });

  console.log(`[local-coder-mcp] Ready! Auth mode: ${config.authMode}. Profile: ${config.toolProfile}`);

  // 9. Graceful shutdown on SIGINT / SIGTERM
  const shutdown = () => {
    console.log("\n[local-coder-mcp] Shutting down gracefully...");
    sessionManager.stopCleanup();
    pluginsSessionManager?.stopCleanup();
    void pluginHub.stop().catch(() => {});
    mcpServer.close(() => {
      adminServer.close(() => {
        console.log("[local-coder-mcp] Stopped.");
        process.exit(0);
      });
    });
    // Force exit after 5s timeout
    setTimeout(() => process.exit(0), 5000).unref();
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[local-coder-mcp] Fatal error during startup:", err);
  process.exit(1);
});
