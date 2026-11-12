import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createTestEnvironment } from "./helpers.js";
import { createMcpServer } from "../src/mcp/server.js";
import { PLAN_NUDGE_HINT, resetPlanNudgeTracking, getAgentMemory, saveAgentMemory, getWorkspaceHash } from "../src/tools/lib/memory.js";
import { todoTool } from "../src/tools/memory.js";
import { workspaceSwitchTool } from "../src/tools/workspace.js";
import { editFilesTool } from "../src/tools/files.js";
import { execTool } from "../src/tools/exec.js";
import { buildInstructions } from "../src/mcp/instructions.js";

test("plan nudge on changing tools and exec", async (t) => {
  const env = await createTestEnvironment();

  t.after(async () => {
    await env.cleanup();
  });

  t.beforeEach(() => {
    resetPlanNudgeTracking();
  });

  await t.test("nudge appears once for changing tool (edit_files) when plan is empty", async () => {
    await createMcpServer(env.ctx, "sess-1");

    // Clear plan
    await todoTool.handler({ action: "clear" }, env.ctx);

    // Call changing tool via callTool (as exec would)
    const res1 = await env.ctx.callTool!("edit_files", {
      ops: [{ op: "write", path: "test1.txt", content: "data1" }],
    });
    assert.equal(res1.ok, true);
    assert.ok(res1.summary.includes(PLAN_NUDGE_HINT), "Expected nudge on first changing tool");

    // Second call in same session should NOT nudge
    const res2 = await env.ctx.callTool!("edit_files", {
      ops: [{ op: "write", path: "test2.txt", content: "data2" }],
    });
    assert.equal(res2.ok, true);
    assert.ok(!res2.summary.includes(PLAN_NUDGE_HINT), "Second call in same session should not nudge");
  });

  await t.test("nudge does not appear twice in same workspace within 30 min across sessions", async () => {
    // Session 1 nudged
    await createMcpServer(env.ctx, "sess-10");
    await todoTool.handler({ action: "clear" }, env.ctx);

    const res1 = await env.ctx.callTool!("edit_files", {
      ops: [{ op: "write", path: "test3.txt", content: "data3" }],
    });
    assert.ok(res1.summary.includes(PLAN_NUDGE_HINT));

    // Session 2 in same workspace within 30 min
    const session2Ctx = { ...env.ctx };
    await createMcpServer(session2Ctx, "sess-20");

    const res2 = await session2Ctx.callTool!("edit_files", {
      ops: [{ op: "write", path: "test4.txt", content: "data4" }],
    });
    assert.ok(!res2.summary.includes(PLAN_NUDGE_HINT), "Should not nudge again in same workspace within 30 min");
  });

  await t.test("nudge does not appear for read-only tools", async () => {
    await createMcpServer(env.ctx, "sess-read");
    await todoTool.handler({ action: "clear" }, env.ctx);

    const res = await env.ctx.callTool!("read", { path: "test1.txt" });
    assert.equal(res.ok, true);
    assert.ok(!res.summary.includes(PLAN_NUDGE_HINT));
  });

  await t.test("nudge does not appear for run verify:true", async () => {
    await createMcpServer(env.ctx, "sess-verify");
    await todoTool.handler({ action: "clear" }, env.ctx);

    const res = await env.ctx.callTool!("run", { verify: true });
    // verify may pass or fail depending on repo, but should not have plan nudge
    assert.ok(!res.summary.includes(PLAN_NUDGE_HINT));
  });

  await t.test("nudge does not appear inside todo, resume, or finish", async () => {
    await createMcpServer(env.ctx, "sess-meta");
    await todoTool.handler({ action: "clear" }, env.ctx);

    const resTodo = await env.ctx.callTool!("todo", { action: "list" });
    assert.ok(!resTodo.summary.includes(PLAN_NUDGE_HINT));

    const resResume = await env.ctx.callTool!("resume", {});
    assert.ok(!resResume.summary.includes(PLAN_NUDGE_HINT));
  });

  await t.test("nudge does not appear when a fresh plan exists", async () => {
    await createMcpServer(env.ctx, "sess-fresh");

    // Set fresh plan (< 2h, not all done)
    await todoTool.handler(
      {
        action: "set",
        items: [
          { text: "Task A", status: "pending" },
          { text: "Task B", status: "done" },
        ],
      },
      env.ctx
    );

    const res = await env.ctx.callTool!("edit_files", {
      ops: [{ op: "write", path: "fresh.txt", content: "data" }],
    });
    assert.equal(res.ok, true);
    assert.ok(!res.summary.includes(PLAN_NUDGE_HINT), "Should not nudge when fresh plan exists");
  });

  await t.test("nudge appears when plan is all done or stale (> 2h)", async () => {
    await createMcpServer(env.ctx, "sess-stale");

    // Plan with all done
    await todoTool.handler(
      {
        action: "set",
        items: [{ text: "Done task", status: "done" }],
      },
      env.ctx
    );

    const resDone = await env.ctx.callTool!("edit_files", {
      ops: [{ op: "write", path: "done.txt", content: "data" }],
    });
    assert.equal(resDone.ok, true);
    assert.ok(resDone.summary.includes(PLAN_NUDGE_HINT), "Should nudge when plan is all done");

    // Reset rate limit and set plan older than 2h
    resetPlanNudgeTracking();
    const staleCtx = { ...env.ctx };
    await createMcpServer(staleCtx, "sess-stale2");

    const staleDate = new Date(Date.now() - 3 * 3600 * 1000).toISOString(); // 3h ago
    const hash = getWorkspaceHash(env.workspaceDir);
    await fs.writeFile(
      path.join(env.config.dataDir, "agent", `${hash}.json`),
      JSON.stringify({
        workspace: env.workspaceDir,
        updatedAt: staleDate,
        todos: [{ id: "1", text: "Stale task", status: "pending" }],
      })
    );

    const resStale = await staleCtx.callTool!("edit_files", {
      ops: [{ op: "write", path: "stale.txt", content: "data" }],
    });
    assert.equal(resStale.ok, true);
    assert.ok(resStale.summary.includes(PLAN_NUDGE_HINT), "Should nudge when plan is older than 2h");
  });

  await t.test("nudge works through exec tool when calling changing tool", async () => {
    resetPlanNudgeTracking();
    const execCtx = { ...env.ctx };
    await createMcpServer(execCtx, "sess-exec");
    await todoTool.handler({ action: "clear" }, execCtx);

    const res = await execTool.handler(
      {
        code: `const r = await tools.edit_files({ ops: [{ op: "write", path: "from_exec.txt", content: "data" }] }); text(r.summary);`,
      },
      execCtx
    );
    assert.equal(res.ok, true);
    assert.ok((res.data as any)?.text?.includes(PLAN_NUDGE_HINT), "Exec should capture nudge in tool result summary");
    assert.ok(res.summary.includes(PLAN_NUDGE_HINT), "Exec own summary should also include nudge");
  });

  await t.test("exec whose script ignores inner results still shows the nudge in exec's summary", async () => {
    resetPlanNudgeTracking();
    const execCtx = { ...env.ctx };
    await createMcpServer(execCtx, "sess-exec-ignore");
    await todoTool.handler({ action: "clear" }, execCtx);

    const res = await execTool.handler(
      {
        code: `await tools.edit_files({ ops: [{ op: "write", path: "from_exec_quiet.txt", content: "quiet" }] });`,
      },
      execCtx
    );
    assert.equal(res.ok, true);
    assert.ok(!(res.data as any)?.text?.includes(PLAN_NUDGE_HINT), "Inner text should not contain nudge");
    assert.ok(res.summary.includes(PLAN_NUDGE_HINT), "Exec summary should contain nudge even when script ignores inner result");

    // Second call in same session should NOT nudge exec again
    const res2 = await execTool.handler(
      {
        code: `await tools.edit_files({ ops: [{ op: "write", path: "from_exec_quiet2.txt", content: "quiet2" }] });`,
      },
      execCtx
    );
    assert.equal(res2.ok, true);
    assert.ok(!res2.summary.includes(PLAN_NUDGE_HINT), "Exec summary should not nudge twice in same session");
  });

  await t.test("corrupt memory file → no throw", async () => {
    resetPlanNudgeTracking();
    await createMcpServer(env.ctx, "sess-corrupt");

    const hash = getWorkspaceHash(env.workspaceDir);
    const memFile = path.join(env.config.dataDir, "agent", `${hash}.json`);
    await fs.mkdir(path.dirname(memFile), { recursive: true });
    await fs.writeFile(memFile, "{ INVALID JSON CORRUPT FILE !!!", "utf-8");

    // Changing tool does not throw
    const resEdit = await env.ctx.callTool!("edit_files", {
      ops: [{ op: "write", path: "corrupt_test.txt", content: "data" }],
    });
    assert.equal(resEdit.ok, true);

    // Switch does not throw
    const resSwitch = await workspaceSwitchTool.handler({ path: env.workspaceDir }, env.ctx);
    assert.equal(resSwitch.ok, true);

    // Finish does not throw
    const resFinish = await env.ctx.callTool!("finish", { summary: "Corrupt memory test" });
    assert.equal(resFinish.ok, true);
  });

  await t.test("nothing nudges when session has ctx.board undefined", async () => {
    resetPlanNudgeTracking();
    const noBoardCtx = { ...env.ctx, board: undefined };
    await createMcpServer(noBoardCtx, "sess-no-board");
    await todoTool.handler({ action: "clear" }, noBoardCtx);

    const resEdit = await noBoardCtx.callTool!("edit_files", {
      ops: [{ op: "write", path: "no_board.txt", content: "data" }],
    });
    assert.equal(resEdit.ok, true);
    assert.ok(!resEdit.summary.includes(PLAN_NUDGE_HINT), "Should not nudge when ctx.board is undefined");

    const resSwitch = await workspaceSwitchTool.handler({ path: env.workspaceDir }, noBoardCtx);
    assert.equal(resSwitch.ok, true);
    assert.ok(!resSwitch.summary.includes(PLAN_NUDGE_HINT), "Switch should not nudge when ctx.board is undefined");
  });
});

test("workspace_switch plan moving and hints", async (t) => {
  const env = await createTestEnvironment();

  t.after(async () => {
    await env.cleanup();
  });

  const parentDir = env.workspaceDir;
  const childDir = path.join(parentDir, "subproject");
  const siblingDir = path.join(env.tempDir, "sibling");

  await fs.mkdir(childDir, { recursive: true });
  await fs.mkdir(siblingDir, { recursive: true });

  // Update workspace roots so both child and sibling can be activated
  env.workspace.updateRoots?.([parentDir, siblingDir]);

  await t.test("moves plan from parent to child folder if updated in last 2h and not all done", async () => {
    // 1. Ensure active in parent
    env.workspace.setActive(parentDir);

    // 2. Set plan in parent
    await todoTool.handler(
      {
        action: "set",
        items: [
          { text: "Build feature A", status: "in_progress" },
          { text: "Write tests", status: "pending" },
        ],
      },
      env.ctx
    );

    // Collect board plan events
    const boardPlans: any[] = [];
    const unsub = env.board.subscribe((ev) => {
      if (ev.type === "plan") boardPlans.push(ev);
    });

    // 3. Switch to child
    const res = await workspaceSwitchTool.handler({ path: childDir }, env.ctx);
    assert.equal(res.ok, true);
    assert.match(res.summary, /Moved your plan \(2 steps\) from .* to .*/);

    // 4. Verify child now has the plan
    const childMemory = await getAgentMemory(env.config.dataDir, childDir);
    assert.equal(childMemory.todos.length, 2);
    assert.equal(childMemory.todos[0].text, "Build feature A");

    // 5. Verify parent plan was cleared
    const parentMemory = await getAgentMemory(env.config.dataDir, parentDir);
    assert.deepEqual(parentMemory.todos, []);

    // 6. Verify board emitted plan events for both
    const childEmits = boardPlans.filter((p) => path.resolve(p.workspace) === path.resolve(childDir));
    const parentEmits = boardPlans.filter((p) => path.resolve(p.workspace) === path.resolve(parentDir));
    assert.ok(childEmits.length > 0 && childEmits[childEmits.length - 1].todos.length === 2);
    assert.ok(parentEmits.length > 0 && parentEmits[parentEmits.length - 1].todos.length === 0);

    unsub();
  });

  await t.test("does not move plan into a sibling folder, but adds hint line if target has no plan", async () => {
    // Active is childDir, which currently has a 2-step plan
    assert.equal(path.resolve(env.workspace.active()), path.resolve(childDir));

    // Clear sibling plan so it has no plan
    await saveAgentMemory(env.config.dataDir, siblingDir, {
      workspace: siblingDir,
      updatedAt: new Date().toISOString(),
      todos: [],
    });

    const res = await workspaceSwitchTool.handler({ path: siblingDir }, env.ctx);
    assert.equal(res.ok, true);
    assert.ok(!res.summary.includes("Moved your plan"), "Should not move plan to sibling");
    assert.ok(res.summary.includes(PLAN_NUDGE_HINT), "Should add hint line when target has no plan");

    // Child still has its plan
    const childMemory = await getAgentMemory(env.config.dataDir, childDir);
    assert.equal(childMemory.todos.length, 2);
  });

  await t.test("does not move plan when child already has a current plan", async () => {
    // 1. Switch back to parent and set a fresh plan
    env.workspace.setActive(parentDir);
    await todoTool.handler(
      {
        action: "set",
        items: [{ text: "Parent task", status: "pending" }],
      },
      env.ctx
    );

    // 2. Child already has its 2-step plan from earlier
    const childMemBefore = await getAgentMemory(env.config.dataDir, childDir);
    assert.equal(childMemBefore.todos.length, 2);

    // 3. Switch to child
    const res = await workspaceSwitchTool.handler({ path: childDir }, env.ctx);
    assert.equal(res.ok, true);
    assert.ok(!res.summary.includes("Moved your plan"), "Should not overwrite child's current plan");
    assert.ok(!res.summary.includes(PLAN_NUDGE_HINT), "Child has a plan so no hint line");

    // Child plan preserved
    const childMemAfter = await getAgentMemory(env.config.dataDir, childDir);
    assert.equal(childMemAfter.todos.length, 2);

    // Parent plan preserved
    const parentMemAfter = await getAgentMemory(env.config.dataDir, parentDir);
    assert.equal(parentMemAfter.todos.length, 1);
  });

  await t.test("does not move plan when previous plan is all done or stale (> 2h)", async () => {
    // 1. Set parent plan to all done
    env.workspace.setActive(parentDir);
    await todoTool.handler(
      {
        action: "set",
        items: [{ text: "Finished parent task", status: "done" }],
      },
      env.ctx
    );

    // Clear child plan
    await saveAgentMemory(env.config.dataDir, childDir, {
      workspace: childDir,
      updatedAt: new Date().toISOString(),
      todos: [],
    });

    // Switch to child
    const res = await workspaceSwitchTool.handler({ path: childDir }, env.ctx);
    assert.equal(res.ok, true);
    assert.ok(!res.summary.includes("Moved your plan"), "Should not move all-done plan");
    assert.ok(res.summary.includes(PLAN_NUDGE_HINT), "Child has no plan so hint line added");
  });

  await t.test("two switches in a row show the hint once", async () => {
    resetPlanNudgeTracking();
    env.ctx.sessionNudged = new Set<string>();

    const targetDir = path.join(env.tempDir, "unplanned-switch");
    await fs.mkdir(targetDir, { recursive: true });
    env.workspace.updateRoots?.([parentDir, siblingDir, targetDir]);

    const res1 = await workspaceSwitchTool.handler({ path: targetDir }, env.ctx);
    assert.equal(res1.ok, true);
    assert.ok(res1.summary.includes(PLAN_NUDGE_HINT), "First switch should show hint");

    const res2 = await workspaceSwitchTool.handler({ path: targetDir }, env.ctx);
    assert.equal(res2.ok, true);
    assert.ok(!res2.summary.includes(PLAN_NUDGE_HINT), "Second switch in a row should not show hint");
  });

  await t.test("switch into unplanned folder marks hint as shown so next edit does not repeat it", async () => {
    resetPlanNudgeTracking();
    const switchCtx = { ...env.ctx };
    await createMcpServer(switchCtx, "sess-switch-edit");

    const targetDir = path.join(env.tempDir, "switch-edit-target");
    await fs.mkdir(targetDir, { recursive: true });
    switchCtx.workspace.updateRoots?.([parentDir, siblingDir, targetDir]);

    const resSwitch = await workspaceSwitchTool.handler({ path: targetDir }, switchCtx);
    assert.ok(resSwitch.summary.includes(PLAN_NUDGE_HINT), "Switch should show hint");

    const resEdit = await switchCtx.callTool!("edit_files", {
      ops: [{ op: "write", path: path.join(targetDir, "file.txt"), content: "content" }],
    });
    assert.equal(resEdit.ok, true);
    assert.ok(!resEdit.summary.includes(PLAN_NUDGE_HINT), "Subsequent edit should not repeat hint");
  });
});

test("instructions contain plan rule", async () => {
  const env = await createTestEnvironment();
  try {
    const instructions = await buildInstructions(env.ctx);
    assert.ok(
      instructions.includes(
        "Start any task with 3+ steps by calling todo set (3–7 short steps); mark each step in_progress/done as you go; when you switch into a new project folder your plan moves with you; update the plan before finish"
      )
    );
  } finally {
    await env.cleanup();
  }
});
