import test, { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createAdminApp } from "../src/admin/app.js";
import { createMcpApp } from "../src/http/app.js";
import { createMemoryActivityLog } from "../src/core/activity.js";
import { createSkillRegistry } from "../src/skills/index.js";
import { createCommandRegistry } from "../src/commands/index.js";
import { initSettings, getSettings } from "../src/core/settings.js";
import { resolveWorkspaces } from "../src/core/workspace.js";
import type { AppConfig } from "../src/config.js";

describe("Editable Workspace Roots & Admin API", () => {
  let tmpDir: string;
  let mountDir: string;
  let allowedDir2: string;
  let outsideDir: string;
  let envRoot: string;
  let customRoot1: string;
  let customRoot2: string;
  let customSub1: string;

  let config: AppConfig;
  let adminServer: http.Server;
  let mcpServer: http.Server;
  let adminBaseUrl: string;
  let mcpBaseUrl: string;
  let sessionManagerRef: any;

  const testToken = "test-token-workspaces-123";

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-test-"));
    mountDir = path.join(tmpDir, "mount");
    allowedDir2 = path.join(tmpDir, "allowed2");
    outsideDir = path.join(tmpDir, "outside");
    envRoot = path.join(mountDir, "env-project");
    customRoot1 = path.join(mountDir, "custom1");
    customRoot2 = path.join(allowedDir2, "custom2");
    customSub1 = path.join(customRoot1, "subdir");

    fs.mkdirSync(mountDir, { recursive: true });
    fs.mkdirSync(allowedDir2, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.mkdirSync(envRoot, { recursive: true });
    fs.mkdirSync(customRoot1, { recursive: true });
    fs.mkdirSync(customRoot2, { recursive: true });
    fs.mkdirSync(customSub1, { recursive: true });

    config = {
      port: 8787,
      hostPort: 8787,
      adminPort: 8788,
      host: "127.0.0.1",
      adminHost: "127.0.0.1",
      mcpToken: testToken,
      publicUrl: "",
      tunnelMetricsUrl: "",
      chromiumPath: "",
      authMode: "token",
      workspaceRoots: [envRoot],
      defaultWorkspace: envRoot,
      allowedRootAreas: [mountDir, allowedDir2],
      mountDirs: [mountDir],
      dataDir: path.join(tmpDir, "data"),
      builtinSkillsDir: path.join(tmpDir, "skills"),
      userSkillsDir: path.join(tmpDir, "user_skills"),
      extraSkillsDirs: [],
      builtinCommandsDir: path.join(tmpDir, "commands"),
      builtinPluginsDir: path.join(tmpDir, "plugins"),
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

    initSettings(config.dataDir, {
      approvalMode: "standard",
      toolProfile: "essential",
    });

    const activity = createMemoryActivityLog();
    const skills = createSkillRegistry(config, {
      get: getSettings,
      update: async () => getSettings(),
    });
    const commands = createCommandRegistry(config);

    const { app: mcpApp, sessionManager } = createMcpApp({
      config,
      activity,
      skills,
      commands,
    });
    sessionManagerRef = sessionManager;

    const adminApp = createAdminApp({
      config,
      activity,
      skills,
      commands,
      sessionManager,
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
    mcpServer.closeAllConnections?.();
    adminServer.closeAllConnections?.();
    await new Promise<void>((resolve) => mcpServer.close(() => resolve()));
    await new Promise<void>((resolve) => adminServer.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resolves default status with workspaceRoots from env", async () => {
    const res = await fetch(`${adminBaseUrl}/api/status`, {
      headers: { host: "localhost" },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.workspaceRoots, [envRoot]);
    assert.equal(body.defaultWorkspace, envRoot);
    assert.equal(body.workspaceSource, "env");
    assert.deepEqual(body.mountDirs, [mountDir]);
  });

  it("valid save: updates roots and default workspace", async () => {
    const res = await fetch(`${adminBaseUrl}/api/workspaces`, {
      method: "PUT",
      headers: { host: "localhost", "Content-Type": "application/json" },
      body: JSON.stringify({
        roots: [customRoot1, customRoot2],
        defaultWorkspace: customRoot2,
      }),
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.roots, [customRoot1, customRoot2]);
    assert.equal(body.defaultWorkspace, customRoot2);
    assert.equal(body.source, "settings");

    // Verify /api/status reports the effective settings
    const statusRes = await fetch(`${adminBaseUrl}/api/status`, {
      headers: { host: "localhost" },
    });
    assert.equal(statusRes.status, 200);
    const status = await statusRes.json();
    assert.deepEqual(status.workspaceRoots, [customRoot1, customRoot2]);
    assert.equal(status.defaultWorkspace, customRoot2);
    assert.equal(status.workspaceSource, "settings");
  });

  it("outside area 400: rejects root path outside allowedRootAreas", async () => {
    const res = await fetch(`${adminBaseUrl}/api/workspaces`, {
      method: "PUT",
      headers: { host: "localhost", "Content-Type": "application/json" },
      body: JSON.stringify({
        roots: [outsideDir],
      }),
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.error?.includes("outside allowed mount areas"));
    assert.ok(body.error?.includes("MOUNT_DIR") || body.error?.includes("ALLOWED_ROOTS"));
  });

  it("missing dir 400: rejects non-existent path or file path", async () => {
    // 1. Non-existent path
    const nonExistent = path.join(mountDir, "does-not-exist-dir");
    const resMissing = await fetch(`${adminBaseUrl}/api/workspaces`, {
      method: "PUT",
      headers: { host: "localhost", "Content-Type": "application/json" },
      body: JSON.stringify({
        roots: [nonExistent],
      }),
    });

    assert.equal(resMissing.status, 400);
    const bodyMissing = await resMissing.json();
    assert.ok(bodyMissing.error?.includes("does not exist"));

    // 2. Regular file path (not a directory)
    const filePath = path.join(mountDir, "plain-file.txt");
    fs.writeFileSync(filePath, "sample content");
    const resFile = await fetch(`${adminBaseUrl}/api/workspaces`, {
      method: "PUT",
      headers: { host: "localhost", "Content-Type": "application/json" },
      body: JSON.stringify({
        roots: [filePath],
      }),
    });

    assert.equal(resFile.status, 400);
    const bodyFile = await resFile.json();
    assert.ok(bodyFile.error?.includes("not a directory"));
  });

  it("default not inside roots 400: rejects defaultWorkspace outside given roots", async () => {
    // Both customRoot1 and customRoot2 are inside allowedRootAreas,
    // but customRoot2 is not inside customRoot1.
    const res = await fetch(`${adminBaseUrl}/api/workspaces`, {
      method: "PUT",
      headers: { host: "localhost", "Content-Type": "application/json" },
      body: JSON.stringify({
        roots: [customRoot1],
        defaultWorkspace: customRoot2,
      }),
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.error?.includes("not inside any of the configured workspace roots"));
  });

  it("DELETE resets: reverts workspace roots and default back to env", async () => {
    const res = await fetch(`${adminBaseUrl}/api/workspaces`, {
      method: "DELETE",
      headers: { host: "localhost" },
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.roots, [envRoot]);
    assert.equal(body.defaultWorkspace, envRoot);
    assert.equal(body.source, "env");

    // Verify /api/status reports env roots again
    const statusRes = await fetch(`${adminBaseUrl}/api/status`, {
      headers: { host: "localhost" },
    });
    assert.equal(statusRes.status, 200);
    const status = await statusRes.json();
    assert.deepEqual(status.workspaceRoots, [envRoot]);
    assert.equal(status.defaultWorkspace, envRoot);
    assert.equal(status.workspaceSource, "env");
  });

  it("fs/dirs hides dot-dirs and refuses outside paths", async () => {
    const testBrowsingDir = path.join(mountDir, "browsing-test");
    fs.mkdirSync(testBrowsingDir, { recursive: true });

    const visibleDir1 = path.join(testBrowsingDir, "folderA");
    const visibleDir2 = path.join(testBrowsingDir, "repoB");
    const hiddenDir = path.join(testBrowsingDir, ".dot-folder");
    const nodeModulesDir = path.join(testBrowsingDir, "node_modules");

    fs.mkdirSync(visibleDir1, { recursive: true });
    fs.mkdirSync(visibleDir2, { recursive: true });
    fs.mkdirSync(path.join(visibleDir2, ".git"), { recursive: true }); // git repo
    fs.mkdirSync(hiddenDir, { recursive: true });
    fs.mkdirSync(nodeModulesDir, { recursive: true });

    // 1. Browsing valid directory
    const res = await fetch(`${adminBaseUrl}/api/fs/dirs?path=${encodeURIComponent(testBrowsingDir)}`, {
      headers: { host: "localhost" },
    });
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.path, testBrowsingDir);
    assert.equal(body.parent, mountDir);

    const names = body.dirs.map((d: any) => d.name);
    assert.ok(names.includes("folderA"), "Should include folderA");
    assert.ok(names.includes("repoB"), "Should include repoB");
    assert.ok(!names.includes(".dot-folder"), "Must hide dot-directories");
    assert.ok(!names.includes("node_modules"), "Must hide node_modules");

    const repoItem = body.dirs.find((d: any) => d.name === "repoB");
    assert.ok(repoItem);
    assert.equal(repoItem.isGitRepo, true, "repoB should be marked as git repo");

    const folderItem = body.dirs.find((d: any) => d.name === "folderA");
    assert.ok(folderItem);
    assert.equal(folderItem.isGitRepo, false, "folderA is not a git repo");

    // 2. Refuses path outside allowed areas
    const resOutside = await fetch(`${adminBaseUrl}/api/fs/dirs?path=${encodeURIComponent(outsideDir)}`, {
      headers: { host: "localhost" },
    });
    assert.equal(resOutside.status, 400);
    const bodyOutside = await resOutside.json();
    assert.ok(bodyOutside.error?.includes("outside the allowed mount areas"));

    // 3. Refuses non-existent path
    const resMissing = await fetch(`${adminBaseUrl}/api/fs/dirs?path=${encodeURIComponent(path.join(mountDir, "nope"))}`, {
      headers: { host: "localhost" },
    });
    assert.equal(resMissing.status, 400);
  });

  it("a new session sees the new roots", async () => {
    // Save custom roots
    const putRes = await fetch(`${adminBaseUrl}/api/workspaces`, {
      method: "PUT",
      headers: { host: "localhost", "Content-Type": "application/json" },
      body: JSON.stringify({
        roots: [customRoot1],
        defaultWorkspace: customRoot1,
      }),
    });
    assert.equal(putRes.status, 200);

    // Call /mcp to establish a new session
    const mcpRes = await fetch(`${mcpBaseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${testToken}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "workspace_info",
          arguments: {},
        },
      }),
    });

    assert.equal(mcpRes.status, 200);
    const sid = mcpRes.headers.get("mcp-session-id");
    assert.ok(sid);

    const mcpJson = await mcpRes.json();
    assert.ok(!mcpJson.result?.isError);

    // Verify session context roots through sessionManager
    const session = sessionManagerRef.get(sid);
    assert.ok(session);
    assert.deepEqual(session.context.workspace.roots, [customRoot1]);
    assert.equal(session.context.workspace.active(), customRoot1);

    // Switch workspace to valid sub-directory
    const switchRes = await fetch(`${mcpBaseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${testToken}`,
        "mcp-session-id": sid,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "workspace_switch",
          arguments: { path: customSub1 },
        },
      }),
    });

    assert.equal(switchRes.status, 200);
    const switchJson = await switchRes.json();
    assert.ok(!switchJson.result?.isError);
    assert.equal(session.context.workspace.active(), customSub1);

    // Attempt switch to removed envRoot -> must fail
    const invalidSwitchRes = await fetch(`${mcpBaseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${testToken}`,
        "mcp-session-id": sid,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "workspace_switch",
          arguments: { path: envRoot },
        },
      }),
    });

    assert.equal(invalidSwitchRes.status, 200);
    const invalidJson = await invalidSwitchRes.json();
    assert.equal(invalidJson.result?.isError, true);
    assert.ok(invalidJson.result?.content?.[0]?.text?.includes("Not inside a workspace root"));
  });

  it("existing session updates live and falls back to default if current root removed", async () => {
    // 1. Configure roots to [customRoot1, customRoot2] with default customRoot1
    await fetch(`${adminBaseUrl}/api/workspaces`, {
      method: "PUT",
      headers: { host: "localhost", "Content-Type": "application/json" },
      body: JSON.stringify({
        roots: [customRoot1, customRoot2],
        defaultWorkspace: customRoot1,
      }),
    });

    // 2. Start a session in customRoot1
    const res1 = await fetch(`${mcpBaseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${testToken}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: {
          name: "workspace_switch",
          arguments: { path: customRoot1 },
        },
      }),
    });

    const sid = res1.headers.get("mcp-session-id");
    assert.ok(sid);
    const session = sessionManagerRef.get(sid);
    assert.ok(session);
    assert.equal(session.context.workspace.active(), customRoot1);

    // 3. Update roots to only [customRoot2], with default customRoot2
    const putRes = await fetch(`${adminBaseUrl}/api/workspaces`, {
      method: "PUT",
      headers: { host: "localhost", "Content-Type": "application/json" },
      body: JSON.stringify({
        roots: [customRoot2],
        defaultWorkspace: customRoot2,
      }),
    });
    assert.equal(putRes.status, 200);

    // 4. Session's active root was customRoot1 (removed), so it must have fallen back to customRoot2
    assert.deepEqual(session.context.workspace.roots, [customRoot2]);
    assert.equal(session.context.workspace.active(), customRoot2);
  });

  it("realpath prevents symlink escapes outside allowedRootAreas", async () => {
    const symlinkPath = path.join(mountDir, "symlink-outside");
    try {
      fs.symlinkSync(outsideDir, symlinkPath);
    } catch {}

    // PUT /api/workspaces rejects symlink pointing outside
    const putRes = await fetch(`${adminBaseUrl}/api/workspaces`, {
      method: "PUT",
      headers: { host: "localhost", "Content-Type": "application/json" },
      body: JSON.stringify({
        roots: [symlinkPath],
      }),
    });
    assert.equal(putRes.status, 400);
    const putBody = await putRes.json();
    assert.ok(putBody.error?.includes("outside allowed mount areas"));

    // GET /api/fs/dirs rejects symlink pointing outside
    const getRes = await fetch(`${adminBaseUrl}/api/fs/dirs?path=${encodeURIComponent(symlinkPath)}`, {
      headers: { host: "localhost" },
    });
    assert.equal(getRes.status, 400);
    const getBody = await getRes.json();
    assert.ok(getBody.error?.includes("outside the allowed mount areas"));
  });
});
