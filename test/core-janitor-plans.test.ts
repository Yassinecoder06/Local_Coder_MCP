import test, { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createAdminApp } from "../src/admin/app.js";
import { createMemoryActivityLog } from "../src/core/activity.js";
import { createBoard } from "../src/core/board.js";
import { runStateJanitor } from "../src/core/janitor.js";
import { initSettings, getSettings } from "../src/core/settings.js";
import { createCommandRegistry } from "../src/commands/index.js";
import { createSkillRegistry } from "../src/skills/index.js";
import { SessionManager } from "../src/http/session-manager.js";
import { getWorkspaceHash, saveAgentMemory } from "../src/tools/lib/memory.js";
import type { AppConfig } from "../src/config.js";

function configFor(root: string, dataDir: string): AppConfig {
  return {
    port: 8787, hostPort: 8787, adminPort: 8788, host: "127.0.0.1", adminHost: "127.0.0.1",
    mcpToken: "test-token", publicUrl: "", tunnelMetricsUrl: "", authMode: "token",
    workspaceRoots: [root], defaultWorkspace: root, allowedRootAreas: [root], mountDirs: [], dataDir,
    builtinSkillsDir: path.join(dataDir, "skills"), userSkillsDir: path.join(dataDir, "user-skills"),
    extraSkillsDirs: [], builtinCommandsDir: path.join(dataDir, "commands"), userCommandsDir: path.join(dataDir, "user-commands"),
    approvalMode: "standard", toolProfile: "essential", shellTimeoutMs: 10000, shellSyncMs: 5000,
    maxOutputBytes: 60000, checkpoints: true, logLevel: "info", version: "1.0.0",
  };
}

describe("state janitor", () => {
  it("cleans missing and outside-root settings and checkpoints, marks orphan plans, and tolerates corrupt files", async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "janitor-test-"));
    const root = path.join(temp, "root");
    const live = path.join(root, "live");
    const missing = path.join(root, "deleted");
    fs.mkdirSync(live, { recursive: true });
    const dataDir = path.join(temp, "data");
    fs.mkdirSync(dataDir);
    initSettings(dataDir);
    const cfg = configFor(root, dataDir);
    fs.writeFileSync(path.join(dataDir, "settings.json"), JSON.stringify({
      disabledTools: [], disabledSkills: [], workspaceRoots: [root],
      lastWorkspace: missing,
      lastWorkspaceByClient: { good: live, deleted: missing, outside: temp },
    }));
    initSettings(dataDir);

    const cpData = path.join(dataDir, "checkpoints", "data");
    fs.mkdirSync(path.join(cpData, "gone"), { recursive: true });
    fs.mkdirSync(path.join(cpData, "live"), { recursive: true });
    fs.writeFileSync(path.join(dataDir, "checkpoints", "index.json"), JSON.stringify({ version: 1, checkpoints: [
      { id: "gone", workspace: missing, files: [] }, { id: "live", workspace: live, files: [] },
    ] }));
    fs.mkdirSync(path.join(dataDir, "agent"), { recursive: true });
    fs.writeFileSync(path.join(dataDir, "agent", `${getWorkspaceHash(missing)}.json`), JSON.stringify({ workspace: missing, updatedAt: "", todos: [{ id: "1", text: "keep", status: "pending" }] }));
    fs.writeFileSync(path.join(dataDir, "agent", "corrupt.json"), "{");

    const result = await runStateJanitor(cfg);
    assert.equal(result.settings, 3);
    assert.equal(result.checkpoints, 1);
    assert.equal(result.orphanedPlans, 1);
    assert.equal(getSettings().lastWorkspace, undefined);
    assert.deepEqual(getSettings().lastWorkspaceByClient, { good: live });
    assert.equal(fs.existsSync(path.join(cpData, "gone")), false);
    assert.equal(fs.existsSync(path.join(cpData, "live")), true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, "agent", `${getWorkspaceHash(missing)}.json`), "utf8")).todos[0].text, "keep");
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, "agent", `${getWorkspaceHash(missing)}.json`), "utf8")).orphaned, true);
    fs.rmSync(temp, { recursive: true, force: true });
  });

  it("leaves a corrupt checkpoint index untouched", async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "janitor-corrupt-"));
    const root = path.join(temp, "root");
    fs.mkdirSync(root);
    const dataDir = path.join(temp, "data");
    fs.mkdirSync(path.join(dataDir, "checkpoints"), { recursive: true });
    fs.writeFileSync(path.join(dataDir, "checkpoints", "index.json"), "{");
    initSettings(dataDir);
    const before = fs.readFileSync(path.join(dataDir, "checkpoints", "index.json"), "utf8");
    await runStateJanitor(configFor(root, dataDir));
    assert.equal(fs.readFileSync(path.join(dataDir, "checkpoints", "index.json"), "utf8"), before);
    fs.rmSync(temp, { recursive: true, force: true });
  });
});

describe("Admin plan API", () => {
  let temp: string;
  let dataDir: string;
  let workspace: string;
  let deletedWorkspace: string;
  let baseUrl: string;
  let server: http.Server;
  let board: ReturnType<typeof createBoard>;

  before(async () => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), "admin-plans-test-"));
    dataDir = path.join(temp, "data");
    workspace = path.join(temp, "live");
    deletedWorkspace = path.join(temp, "deleted");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(workspace);
    initSettings(dataDir);
    const config = configFor(temp, dataDir);
    board = createBoard(dataDir);
    const activity = createMemoryActivityLog();
    const skills = createSkillRegistry(config, { get: () => ({ disabledTools: [], disabledSkills: [] }), update: async () => ({ disabledTools: [], disabledSkills: [] }) });
    const commands = createCommandRegistry(config);
    const sessionManager = new SessionManager({ config, activity, skills, commands, board });
    server = http.createServer(createAdminApp({ config, activity, skills, commands, sessionManager, board }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      resolve();
    }));
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(temp, { recursive: true, force: true });
  });

  it("filters missing workspace plans unless all=1 and clears todos through DELETE", async () => {
    await saveAgentMemory(dataDir, workspace, { workspace, updatedAt: "", todos: [{ id: "1", text: "live plan", status: "pending" }] });
    await saveAgentMemory(dataDir, deletedWorkspace, { workspace: deletedWorkspace, updatedAt: "", todos: [{ id: "2", text: "orphan plan", status: "pending" }] });
    const headers = { host: "localhost" };
    const defaultPlans = await (await fetch(`${baseUrl}/api/plans`, { headers })).json() as Array<{ workspace: string }>;
    assert.deepEqual(defaultPlans.map((item) => item.workspace), [workspace]);
    const allPlans = await (await fetch(`${baseUrl}/api/plans?all=1`, { headers })).json() as Array<{ workspace: string; orphaned?: boolean }>;
    assert.equal(allPlans.find((item) => item.workspace === deletedWorkspace)?.orphaned, true);

    let emitted: unknown;
    const unsubscribe = board.subscribe((event) => { if (event.type === "plan") emitted = event.todos; });
    const cleared = await fetch(`${baseUrl}/api/plans?workspace=${encodeURIComponent(workspace)}`, { method: "DELETE", headers });
    assert.equal(cleared.status, 200);
    assert.deepEqual((await cleared.json() as { todos: unknown[] }).todos, []);
    assert.deepEqual(emitted, []);
    const remaining = JSON.parse(fs.readFileSync(path.join(dataDir, "agent", `${getWorkspaceHash(workspace)}.json`), "utf8"));
    assert.deepEqual(remaining.todos, []);
    unsubscribe();
  });
});
