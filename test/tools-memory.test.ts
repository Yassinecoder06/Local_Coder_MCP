import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createTestEnvironment } from "./helpers.js";
import { todoTool, resumeTool } from "../src/tools/memory.js";
import { getWorkspaceHash } from "../src/tools/lib/memory.js";

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
    assert.match(res.summary, /Active workspace:/);
  });
});
