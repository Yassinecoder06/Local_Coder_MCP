import test, { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createAdminApp } from "../src/admin/app.js";
import { createBoard } from "../src/core/board.js";
import { createMemoryActivityLog } from "../src/core/activity.js";
import { createSkillRegistry } from "../src/skills/index.js";
import { createCommandRegistry } from "../src/commands/index.js";
import { SessionManager } from "../src/http/session-manager.js";
import { initSettings } from "../src/core/settings.js";
import { getWorkspaceHash, saveAgentMemory } from "../src/tools/lib/memory.js";
import type { AppConfig } from "../src/config.js";

describe("Admin Board & Request API Endpoints", () => {
  let tmpDir: string;
  let adminServer: http.Server;
  let adminBaseUrl: string;
  let board: ReturnType<typeof createBoard>;
  let config: AppConfig;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "admin-board-test-"));
    config = {
      port: 8787,
      hostPort: 8787,
      adminPort: 8788,
      host: "127.0.0.1",
      adminHost: "127.0.0.1",
      mcpToken: "test-token-board",
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
    board = createBoard(tmpDir);
    const activity = createMemoryActivityLog();
    const skills = createSkillRegistry(config, {
      get: () => ({ disabledTools: [], disabledSkills: [] }),
      update: async () => ({ disabledTools: [], disabledSkills: [] }),
    });
    const commands = createCommandRegistry(config);
    const sessionManager = new SessionManager({ config, activity, skills, commands, board });

    const adminApp = createAdminApp({
      config,
      activity,
      skills,
      commands,
      sessionManager,
      board,
    });

    adminServer = http.createServer(adminApp);
    await new Promise<void>((resolve) => {
      adminServer.listen(0, "127.0.0.1", () => {
        const port = (adminServer.address() as any).port;
        adminBaseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise<void>((resolve) => adminServer.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("GET /api/status returns openRequests count", async () => {
    const res = await fetch(`${adminBaseUrl}/api/status`, {
      headers: { host: "localhost" },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(typeof body.openRequests, "number");
    assert.equal(body.openRequests, 0);

    // Add an open request and verify openRequests increases
    await board.addRequest({
      workspace: tmpDir,
      cwd: tmpDir,
      command: "sudo echo test",
      purpose: "test openRequests",
    });

    const res2 = await fetch(`${adminBaseUrl}/api/status`, {
      headers: { host: "localhost" },
    });
    const body2 = await res2.json();
    assert.equal(body2.openRequests, 1);
  });

  it("GET /api/requests returns list of requests with filter support", async () => {
    const res = await fetch(`${adminBaseUrl}/api/requests?status=open`, {
      headers: { host: "localhost" },
    });
    assert.equal(res.status, 200);
    const list = await res.json();
    assert.ok(Array.isArray(list));
    assert.equal(list.length, 1);
    assert.equal(list[0].command, "sudo echo test");
    assert.equal(list[0].status, "open");

    // Filter by different workspace
    const resEmpty = await fetch(`${adminBaseUrl}/api/requests?workspace=/nonexistent`, {
      headers: { host: "localhost" },
    });
    const emptyList = await resEmpty.json();
    assert.equal(emptyList.length, 0);
  });

  it("POST /api/requests/:id updates status and validates input", async () => {
    const listRes = await fetch(`${adminBaseUrl}/api/requests`, {
      headers: { host: "localhost" },
    });
    const [existing] = await listRes.json();
    assert.ok(existing);

    // 400: Invalid status
    const invalidRes = await fetch(`${adminBaseUrl}/api/requests/${existing.id}`, {
      method: "POST",
      headers: { host: "localhost", "Content-Type": "application/json" },
      body: JSON.stringify({ status: "invalid_status" }),
    });
    assert.equal(invalidRes.status, 400);
    const invalidBody = await invalidRes.json();
    assert.ok(invalidBody.error);

    // 404: Nonexistent id
    const notFoundRes = await fetch(`${adminBaseUrl}/api/requests/nonexistent-id`, {
      method: "POST",
      headers: { host: "localhost", "Content-Type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    });
    assert.equal(notFoundRes.status, 404);
    const notFoundBody = await notFoundRes.json();
    assert.ok(notFoundBody.error);

    // 200: Successfully mark as done with note
    const okRes = await fetch(`${adminBaseUrl}/api/requests/${existing.id}`, {
      method: "POST",
      headers: { host: "localhost", "Content-Type": "application/json" },
      body: JSON.stringify({ status: "done", note: "Ran manually by user" }),
    });
    assert.equal(okRes.status, 200);
    const updated = await okRes.json();
    assert.equal(updated.id, existing.id);
    assert.equal(updated.status, "done");
    assert.equal(updated.note, "Ran manually by user");

    // 200: Successfully mark as skipped
    const skippedReq = await board.addRequest({
      workspace: tmpDir,
      cwd: tmpDir,
      command: "sudo echo skip",
      purpose: "test skip",
    });
    const skipRes = await fetch(`${adminBaseUrl}/api/requests/${skippedReq.id}`, {
      method: "POST",
      headers: { host: "localhost", "Content-Type": "application/json" },
      body: JSON.stringify({ status: "skipped" }),
    });
    assert.equal(skipRes.status, 200);
    const skipUpdated = await skipRes.json();
    assert.equal(skipUpdated.status, "skipped");
  });

  it("GET /api/finishes returns finish reports", async () => {
    await board.addFinish({
      workspace: tmpDir,
      summary: "Completed migration",
      changedFiles: ["file.ts"],
      evidence: {
        verify: { ok: true, at: new Date().toISOString(), summary: "all passed" },
        openRequests: 0,
      },
      verified: true,
      warnings: [],
    });

    const res = await fetch(`${adminBaseUrl}/api/finishes?limit=10`, {
      headers: { host: "localhost" },
    });
    assert.equal(res.status, 200);
    const finishes = await res.json();
    assert.ok(Array.isArray(finishes));
    assert.equal(finishes.length, 1);
    assert.equal(finishes[0].summary, "Completed migration");
    assert.equal(finishes[0].verified, true);
  });

  it("GET /api/plan returns workspace, todos, and updatedAt", async () => {
    // Write scratch memory
    await saveAgentMemory(config.dataDir, tmpDir, {
      workspace: tmpDir,
      updatedAt: new Date().toISOString(),
      todos: [
        { id: "1", text: "Step 1", status: "done" },
        { id: "2", text: "Step 2", status: "in_progress" },
      ],
    });

    const res = await fetch(`${adminBaseUrl}/api/plan`, {
      headers: { host: "localhost" },
    });
    assert.equal(res.status, 200);
    const plan = await res.json();
    assert.equal(plan.workspace, tmpDir);
    assert.equal(plan.todos.length, 2);
    assert.equal(plan.todos[0].text, "Step 1");
    assert.equal(plan.todos[1].status, "in_progress");
  });

  it("GET /api/plans orders non-empty plans and GET /api/plan defaults to the latest", async () => {
    const olderWorkspace = path.join(tmpDir, "older-project");
    const newerWorkspace = path.join(tmpDir, "newer-project");
    const emptyWorkspace = path.join(tmpDir, "empty-project");
    const agentDir = path.join(config.dataDir, "agent");
    fs.mkdirSync(agentDir, { recursive: true });
    const writeMemory = (workspace: string, updatedAt: string, todos: unknown[]) => {
      fs.writeFileSync(path.join(agentDir, `${getWorkspaceHash(workspace)}.json`), JSON.stringify({ workspace, updatedAt, todos }));
    };
    writeMemory(olderWorkspace, "2026-01-01T00:00:00.000Z", [{ id: "old", text: "Finished", status: "done" }]);
    writeMemory(newerWorkspace, "2026-01-02T00:00:00.000Z", [
      { id: "new", text: "Working", status: "in_progress" },
      { id: "done", text: "Finished", status: "done" },
    ]);
    writeMemory(tmpDir, "2025-12-31T00:00:00.000Z", [{ id: "base", text: "Previous plan", status: "done" }]);
    writeMemory(emptyWorkspace, "2026-01-03T00:00:00.000Z", []);

    const listResponse = await fetch(`${adminBaseUrl}/api/plans`, { headers: { host: "localhost" } });
    assert.equal(listResponse.status, 200);
    const plans = await listResponse.json();
    assert.deepEqual(plans.map((item: { workspace: string }) => item.workspace), [newerWorkspace, olderWorkspace, tmpDir]);
    assert.deepEqual(plans.map((item: { open: number }) => item.open), [1, 0, 0]);
    assert.equal(plans[0].updatedAt, "2026-01-02T00:00:00.000Z");

    const latestResponse = await fetch(`${adminBaseUrl}/api/plan`, { headers: { host: "localhost" } });
    assert.equal(latestResponse.status, 200);
    assert.equal((await latestResponse.json()).workspace, newerWorkspace);

    const selectedResponse = await fetch(`${adminBaseUrl}/api/plan?workspace=${encodeURIComponent(olderWorkspace)}`, { headers: { host: "localhost" } });
    assert.equal(selectedResponse.status, 200);
    assert.equal((await selectedResponse.json()).workspace, olderWorkspace);
  });

  it("GET /api/board/stream streams events via SSE and emits request event", async () => {
    const url = new URL(`${adminBaseUrl}/api/board/stream`);

    let receivedData = "";
    let sseConnected = false;

    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        url,
        {
          headers: { host: "localhost", Accept: "text/event-stream" },
        },
        (res) => {
          assert.equal(res.statusCode, 200);
          assert.equal(res.headers["content-type"], "text/event-stream");

          res.on("data", (chunk: Buffer) => {
            const str = chunk.toString();
            receivedData += str;

            if (str.includes(": connected")) {
              sseConnected = true;
              // Trigger a board request event to be pushed through SSE
              void board.addRequest({
                workspace: tmpDir,
                cwd: tmpDir,
                command: "sudo echo sse-event",
                purpose: "test SSE stream",
              });
            }

            if (receivedData.includes("sse-event")) {
              req.destroy();
              resolve();
            }
          });

          res.on("error", (err) => {
            if ((err as any).code !== "ECONNRESET") reject(err);
          });
        }
      );

      req.on("error", (err) => {
        if ((err as any).code !== "ECONNRESET") reject(err);
      });

      req.end();
    });

    assert.ok(sseConnected, "SSE initial connection header received");
    assert.ok(receivedData.includes('"type":"request"'), "SSE emitted request event");
    assert.ok(receivedData.includes("sse-event"), "SSE event payload contains request details");
  });
});
