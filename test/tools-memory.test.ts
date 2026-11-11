import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createTestEnvironment } from "./helpers.js";
import { todoTool, resumeTool } from "../src/tools/memory.js";
import { getWorkspaceHash, formatRelativeAge } from "../src/tools/lib/memory.js";

test("memory tools: todo and resume", async (t) => {
  const env = await createTestEnvironment();

  t.after(async () => {
    await env.cleanup();
  });

  await t.test("todo: list empty, set, list, update status", async () => {
    // 1. Initially empty
    const listInitial = await todoTool.handler({ action: "list" }, env.ctx);
    assert.equal(listInitial.ok, true);
    assert.deepEqual(listInitial.data.todos, []);

    // 2. Set plan items
    const setRes = await todoTool.handler(
      {
        action: "set",
        items: [
          { text: "Design data schema" },
          { id: "step-2", text: "Implement API router", status: "pending" },
          { text: "Write unit tests" },
        ],
      },
      env.ctx
    );
    assert.equal(setRes.ok, true);
    assert.equal(setRes.data.todos.length, 3);
    assert.equal(setRes.data.todos[0].id, "1");
    assert.equal(setRes.data.todos[0].status, "pending");
    assert.equal(setRes.data.todos[1].id, "step-2");
    assert.equal(setRes.data.todos[2].id, "3");

    // Verify persisted file under DATA_DIR/agent/<workspace-hash>.json
    const hash = getWorkspaceHash(env.workspaceDir);
    const memoryPath = path.join(env.config.dataDir, "agent", `${hash}.json`);
    const fileExists = await fs.access(memoryPath).then(() => true).catch(() => false);
    assert.equal(fileExists, true);

    const savedRaw = await fs.readFile(memoryPath, "utf-8");
    const saved = JSON.parse(savedRaw);
    assert.equal(saved.todos.length, 3);

    // 3. Update status of items
    const update1 = await todoTool.handler(
      { action: "update", id: "1", status: "done" },
      env.ctx
    );
    assert.equal(update1.ok, true);
    assert.equal(update1.data.todos[0].status, "done");

    const update2 = await todoTool.handler(
      { action: "update", id: "step-2", status: "in_progress" },
      env.ctx
    );
    assert.equal(update2.ok, true);
    assert.equal(update2.data.todos[1].status, "in_progress");

    // 4. List reflects updated statuses
    const listUpdated = await todoTool.handler({ action: "list" }, env.ctx);
    assert.equal(listUpdated.ok, true);
    assert.equal(listUpdated.data.todos[0].status, "done");
    assert.equal(listUpdated.data.todos[1].status, "in_progress");
    assert.equal(listUpdated.data.todos[2].status, "pending");
    assert.match(listUpdated.summary, /1 pending, 1 in progress, 1 done/);
  });

  await t.test("resume: returns workspace, todos, activity, git, and running jobs", async () => {
    // Record an activity entry first
    env.ctx.activity.record({
      tool: "edit_files",
      args: "write file.txt",
      ok: true,
      summary: "test edit",
      ms: 10,
    });

    const res = await resumeTool.handler({}, env.ctx);
    assert.equal(res.ok, true);
    assert.ok(res.data.workspace);
    assert.ok(Array.isArray(res.data.todos));
    assert.equal(res.data.todos.length, 3);
    assert.ok(Array.isArray(res.data.recent_activity));
    assert.ok(res.data.recent_activity.length > 0);
    assert.ok(res.data.git);
    assert.ok(Array.isArray(res.data.running_jobs));
    assert.ok(Array.isArray(res.data.open_requests));
    assert.equal(res.data.open_requests.length, 0);
    assert.equal(res.data.last_finish, null);
    assert.match(res.summary, /Active workspace:/);
    assert.match(res.summary, /updated/);
  });

  await t.test("todo action 'clear' empties plan and emits board event", async () => {
    const emittedPlans: any[] = [];
    const unsubscribe = env.board.subscribe((ev) => {
      if (ev.type === "plan") {
        emittedPlans.push(ev);
      }
    });

    const clearRes = await todoTool.handler({ action: "clear" }, env.ctx);
    assert.equal(clearRes.ok, true);
    assert.deepEqual(clearRes.data.todos, []);
    assert.match(clearRes.summary, /Cleared plan/);

    // Verify board emitted event with empty plan
    assert.ok(emittedPlans.length > 0);
    const lastPlan = emittedPlans[emittedPlans.length - 1];
    assert.deepEqual(lastPlan.todos, []);

    // Verify file persisted empty
    const hash = getWorkspaceHash(env.workspaceDir);
    const memoryPath = path.join(env.config.dataDir, "agent", `${hash}.json`);
    const saved = JSON.parse(await fs.readFile(memoryPath, "utf-8"));
    assert.deepEqual(saved.todos, []);

    unsubscribe();
  });

  await t.test("resume and todo get: includes updatedAt, age, and warns when older than 12 h with unfinished items", async () => {
    // Write a plan updated 26 hours ago with an in_progress item
    const hash = getWorkspaceHash(env.workspaceDir);
    const memoryPath = path.join(env.config.dataDir, "agent", `${hash}.json`);
    const date26hAgo = new Date(Date.now() - 26 * 3600 * 1000).toISOString();

    await fs.writeFile(
      memoryPath,
      JSON.stringify({
        workspace: env.workspaceDir,
        updatedAt: date26hAgo,
        todos: [
          { id: "1", text: "Stale task", status: "in_progress" },
          { id: "2", text: "Pending task", status: "pending" },
        ],
      }),
      "utf-8"
    );

    // Test todo action 'get'
    const todoGetRes = await todoTool.handler({ action: "get" }, env.ctx);
    assert.equal(todoGetRes.ok, true);
    assert.equal(todoGetRes.data.updatedAt, date26hAgo);
    assert.equal(todoGetRes.data.age, "26 h ago");
    assert.equal(todoGetRes.data.stale, true);
    assert.match(todoGetRes.summary, /updated 26 h ago/);
    assert.match(todoGetRes.summary, /older than 12 h and not all done/);
    assert.match(todoGetRes.summary, /todo\(\{ action: "clear" \}\)/);

    // Test resume
    const resumeRes = await resumeTool.handler({}, env.ctx);
    assert.equal(resumeRes.ok, true);
    assert.equal(resumeRes.data.updatedAt, date26hAgo);
    assert.equal(resumeRes.data.plan_age, "26 h ago");
    assert.equal(resumeRes.data.stale_plan, true);
    assert.match(resumeRes.summary, /updated 26 h ago/);
    assert.match(resumeRes.summary, /older than 12 h and not all done/);
    assert.match(resumeRes.summary, /todo\(\{ action: "clear" \}\)/);

    // Now test with all done: should NOT warn even if 26h old
    await fs.writeFile(
      memoryPath,
      JSON.stringify({
        workspace: env.workspaceDir,
        updatedAt: date26hAgo,
        todos: [
          { id: "1", text: "Completed task", status: "done" },
        ],
      }),
      "utf-8"
    );

    const allDoneRes = await todoTool.handler({ action: "get" }, env.ctx);
    assert.equal(allDoneRes.data.stale, false);
    assert.ok(!allDoneRes.summary.includes("older than 12 h and not all done"));
  });

  await t.test("resume and todo get: suggests newer plans from other workspaces, skips missing folders", async () => {
    // 1. Create a second workspace folder SubwayFPS that exists
    const subwayDir = path.join(env.tempDir, "SubwayFPS");
    await fs.mkdir(subwayDir, { recursive: true });
    const subwayHash = getWorkspaceHash(subwayDir);
    const subwayDate = new Date(Date.now() - 2 * 3600 * 1000).toISOString(); // 2 hours ago
    await fs.writeFile(
      path.join(env.config.dataDir, "agent", `${subwayHash}.json`),
      JSON.stringify({
        workspace: subwayDir,
        updatedAt: subwayDate,
        todos: [{ id: "1", text: "Subway game feature", status: "pending" }],
      }),
      "utf-8"
    );

    // 2. Create another workspace OlderDir with plan older than current (e.g. 50 hours ago)
    const olderDir = path.join(env.tempDir, "OlderDir");
    await fs.mkdir(olderDir, { recursive: true });
    const olderHash = getWorkspaceHash(olderDir);
    const olderDate = new Date(Date.now() - 50 * 3600 * 1000).toISOString();
    await fs.writeFile(
      path.join(env.config.dataDir, "agent", `${olderHash}.json`),
      JSON.stringify({
        workspace: olderDir,
        updatedAt: olderDate,
        todos: [{ id: "1", text: "Old task", status: "pending" }],
      }),
      "utf-8"
    );

    // 3. Create a workspace entry for DeletedApp where the folder does NOT exist
    const missingDir = path.join(env.tempDir, "DeletedApp");
    const missingHash = getWorkspaceHash(missingDir);
    const missingDate = new Date(Date.now() - 1 * 3600 * 1000).toISOString(); // 1 hour ago
    await fs.writeFile(
      path.join(env.config.dataDir, "agent", `${missingHash}.json`),
      JSON.stringify({
        workspace: missingDir,
        updatedAt: missingDate,
        todos: [{ id: "1", text: "Ghost task", status: "pending" }],
      }),
      "utf-8"
    );

    // Current workspace has 26h old plan
    const hash = getWorkspaceHash(env.workspaceDir);
    const memoryPath = path.join(env.config.dataDir, "agent", `${hash}.json`);
    const date26hAgo = new Date(Date.now() - 26 * 3600 * 1000).toISOString();
    await fs.writeFile(
      memoryPath,
      JSON.stringify({
        workspace: env.workspaceDir,
        updatedAt: date26hAgo,
        todos: [{ id: "1", text: "Current task", status: "pending" }],
      }),
      "utf-8"
    );

    // Call todo get
    const todoRes = await todoTool.handler({ action: "get" }, env.ctx);
    assert.match(todoRes.summary, /newer plan in SubwayFPS \(2 h ago\) — workspace_switch there\?/);
    assert.ok(!todoRes.summary.includes("OlderDir"));
    assert.ok(!todoRes.summary.includes("DeletedApp"));

    // Call resume
    const resumeRes = await resumeTool.handler({}, env.ctx);
    assert.match(resumeRes.summary, /newer plan in SubwayFPS \(2 h ago\) — workspace_switch there\?/);
    assert.ok(!resumeRes.summary.includes("OlderDir"));
    assert.ok(!resumeRes.summary.includes("DeletedApp"));
  });

  await t.test("formatRelativeAge handles minutes, hours, days, and just now", () => {
    const now = 1000000000000;
    assert.equal(formatRelativeAge(now - 10000, now), "just now");
    assert.equal(formatRelativeAge(now - 5 * 60 * 1000, now), "5 m ago");
    assert.equal(formatRelativeAge(now - 2 * 3600 * 1000, now), "2 h ago");
    assert.equal(formatRelativeAge(now - 26 * 3600 * 1000, now), "26 h ago");
    assert.equal(formatRelativeAge(now - 72 * 3600 * 1000, now), "3 d ago");
  });
});
