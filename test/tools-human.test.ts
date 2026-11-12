import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createTestEnvironment } from "./helpers.js";
import { askUserTool, userRequestStatusTool, finishTool } from "../src/tools/human.js";
import { todoTool, resumeTool } from "../src/tools/memory.js";

test("human and finish tools: ask_user, user_request_status, finish", async (t) => {
  const env = await createTestEnvironment();

  t.after(async () => {
    await env.cleanup();
  });

  await t.test("ask_user tool metadata & contract", () => {
    assert.equal(askUserTool.name, "ask_user");
    assert.equal(askUserTool.risk, "read");
    assert.equal(askUserTool.group, "workspace");
    assert.match(askUserTool.description, /never runs anything/i);
    assert.match(askUserTool.description, /never use it for an action you declined or that was refused for safety/i);
  });

  await t.test("ask_user: basic request creation, defaults, and deduplication", async () => {
    // 1. Create a request with default cwd
    const res = await askUserTool.handler(
      {
        command: "npm install some-native-tool",
        purpose: "Install required CLI tool",
        expected_files: ["package.json"],
      },
      env.ctx
    );

    assert.equal(res.ok, true);
    assert.ok(res.data.id);
    assert.equal(res.data.status, "open");
    assert.equal(res.data.command, "npm install some-native-tool");
    assert.equal(res.data.cwd, env.workspaceDir);
    assert.equal(res.data.purpose, "Install required CLI tool");
    assert.deepEqual(res.data.expected_files, [path.join(env.workspaceDir, "package.json")]);
    assert.match(res.summary, /The person will see a card with Copy \/ Mark done \/ Skip/);

    const firstId = res.data.id;

    // 2. Dedupe: calling ask_user with identical command and cwd in same workspace returns existing request
    const dedupeRes = await askUserTool.handler(
      {
        command: "npm install some-native-tool",
        purpose: "Install again",
      },
      env.ctx
    );

    assert.equal(dedupeRes.ok, true);
    assert.equal(dedupeRes.data.id, firstId);

    // Verify it is on the board
    const onBoard = await env.board.getRequest(firstId);
    assert.ok(onBoard);
    assert.equal(onBoard.status, "open");
  });

  await t.test("ask_user: rejects cwd outside workspace roots", async () => {
    const res = await askUserTool.handler(
      {
        command: "ls -la",
        cwd: "/etc",
        purpose: "Inspect root system",
      },
      env.ctx
    );

    assert.equal(res.ok, false);
    assert.match(res.error || "", /cwd must resolve inside a workspace root/);
  });

  await t.test("ask_user: rejects expected files outside workspace roots", async () => {
    const res = await askUserTool.handler(
      {
        command: "touch /etc/passwd",
        purpose: "Inspect file",
        expected_files: ["/etc/passwd"],
      },
      env.ctx
    );

    assert.equal(res.ok, false);
    assert.match(res.error || "", /expected file path outside workspace/);
  });

  await t.test("ask_user: rejects > 10 expected files or empty command", async () => {
    const tenPlusOne = Array.from({ length: 11 }, (_, i) => `file${i}.txt`);
    const resTooMany = await askUserTool.handler(
      {
        command: "touch files",
        purpose: "Create files",
        expected_files: tenPlusOne,
      },
      env.ctx
    );
    assert.equal(resTooMany.ok, false);

    const resEmptyCmd = await askUserTool.handler(
      {
        command: "   ",
        purpose: "Empty command",
      },
      env.ctx
    );
    assert.equal(resEmptyCmd.ok, false);
  });

  await t.test("user_request_status: inspects file existence, size, mtime without reading contents", async () => {
    const expectedFilePath = path.join(env.workspaceDir, "built-artifact.bin");

    // Add a new request expecting built-artifact.bin
    const reqRes = await askUserTool.handler(
      {
        command: "cargo build --release",
        purpose: "Compile native binary",
        expected_files: ["built-artifact.bin"],
      },
      env.ctx
    );
    assert.equal(reqRes.ok, true);
    const reqId = reqRes.data.id;

    // Check status before file exists
    const statusBefore = await userRequestStatusTool.handler({ ids: [reqId] }, env.ctx);
    assert.equal(statusBefore.ok, true);
    assert.equal(statusBefore.data.requests.length, 1);
    const reqDataBefore = statusBefore.data.requests[0];
    assert.equal(reqDataBefore.id, reqId);
    assert.equal(reqDataBefore.status, "open");
    assert.equal(reqDataBefore.expected_files.length, 1);
    assert.equal(reqDataBefore.expected_files[0].path, expectedFilePath);
    assert.equal(reqDataBefore.expected_files[0].exists, false);

    // Create the expected file
    await fs.writeFile(expectedFilePath, "binary payload contents");

    // Check status again
    const statusAfter = await userRequestStatusTool.handler({ ids: [reqId] }, env.ctx);
    assert.equal(statusAfter.ok, true);
    const reqDataAfter = statusAfter.data.requests[0];
    assert.equal(reqDataAfter.expected_files[0].exists, true);
    assert.equal(reqDataAfter.expected_files[0].size, 23);
    assert.ok(reqDataAfter.expected_files[0].mtime);
    // Ensure file contents are never exposed in the response
    assert.equal("content" in reqDataAfter.expected_files[0], false);

    // User marks request done via board with a note
    await env.board.setRequestStatus(reqId, "done", "Compiled successfully with cargo");

    const statusDone = await userRequestStatusTool.handler({}, env.ctx);
    assert.equal(statusDone.ok, true);
    const foundDone = statusDone.data.requests.find((r: any) => r.id === reqId);
    assert.ok(foundDone);
    assert.equal(foundDone.status, "done");
    assert.equal(foundDone.note, "Compiled successfully with cargo");
  });

  await t.test("finish: unverified when no passing verify/browser_check in activity", async () => {
    const res = await finishTool.handler(
      {
        summary: "Implemented authentication flow",
      },
      env.ctx
    );

    assert.equal(res.ok, true);
    assert.equal(res.data.verified, false);
    assert.ok(res.data.warnings.length > 0);
    assert.match(res.data.warnings.join("; "), /No passing verify|open user request/);
    assert.match(res.summary, /NOT verified/);
  });

  await t.test("finish: unverified when open user request exists", async () => {
    // Record a passing run with verify:true in activity
    env.ctx.activity.record({
      tool: "run",
      args: JSON.stringify({ verify: true }),
      ok: true,
      summary: "All 3 checks passed",
      ms: 1500,
    });

    // Ensure there is at least one open request from previous tests
    const openReqs = await env.board.listRequests({ workspace: env.workspaceDir, status: "open" });
    assert.ok(openReqs.length > 0);

    const res = await finishTool.handler(
      {
        summary: "Ready to finish",
      },
      env.ctx
    );

    assert.equal(res.ok, true);
    assert.equal(res.data.verified, false);
    assert.match(res.data.warnings.join("; "), /open user request/);
  });

  await t.test("finish: unverified when edit_files happened AFTER last passing verify", async () => {
    // 1. Close all open requests
    const openReqs = await env.board.listRequests({ workspace: env.workspaceDir, status: "open" });
    for (const r of openReqs) {
      await env.board.setRequestStatus(r.id, "done");
    }

    // 2. Passing verify
    env.ctx.activity.record({
      tool: "run",
      args: JSON.stringify({ verify: true }),
      ok: true,
      summary: "All 3 checks passed",
      ms: 1200,
    });

    // 3. Edit files occurs AFTER verify
    env.ctx.activity.record({
      tool: "edit_files",
      args: JSON.stringify({ path: "src/auth.ts" }),
      ok: true,
      summary: "Modified src/auth.ts",
      ms: 30,
    });

    const res = await finishTool.handler(
      {
        summary: "Completed edits",
      },
      env.ctx
    );

    assert.equal(res.ok, true);
    assert.equal(res.data.verified, false);
    assert.match(res.data.warnings.join("; "), /No passing verify since the last edit/);
    assert.match(res.summary, /NOT verified/);
  });

  await t.test("finish: verified true when passing verify is newer than edit_files and no open requests", async () => {
    // Set a completed plan so no plan warning is emitted
    await todoTool.handler(
      { action: "set", items: [{ text: "Fix bug", status: "done" }] },
      env.ctx
    );

    // 1. Record edit
    env.ctx.activity.record({
      tool: "edit_files",
      args: JSON.stringify({ path: "src/fix.ts" }),
      ok: true,
      summary: "Fixed bug",
      ms: 25,
    });

    // 2. Record passing verify after edit
    env.ctx.activity.record({
      tool: "run",
      args: JSON.stringify({ verify: true }),
      ok: true,
      summary: "All 4 checks passed",
      ms: 1800,
    });

    const res = await finishTool.handler(
      {
        summary: "Bug fix complete and verified",
        changed_files: ["src/fix.ts"],
      },
      env.ctx
    );

    assert.equal(res.ok, true);
    assert.equal(res.data.verified, true);
    assert.deepEqual(res.data.warnings, []);
    assert.match(res.summary, /Task completed and verified/);

    // Verify stored on board
    const finishes = await env.board.listFinishes({ workspace: env.workspaceDir, limit: 1 });
    assert.equal(finishes.length, 1);
    assert.equal(finishes[0].verified, true);
    assert.equal(finishes[0].summary, "Bug fix complete and verified");
    assert.equal(finishes[0].evidence.verify?.ok, true);
  });

  await t.test("finish: verified true when passing browser_check is newer than edit_files", async () => {
    // Set a completed plan so no plan warning is emitted
    await todoTool.handler(
      { action: "set", items: [{ text: "UI update", status: "done" }] },
      env.ctx
    );

    // 1. Record edit
    env.ctx.activity.record({
      tool: "edit_files",
      args: JSON.stringify({ path: "ui/button.html" }),
      ok: true,
      summary: "Updated button styling",
      ms: 20,
    });

    // 2. Record passing browser_check after edit
    env.ctx.activity.record({
      tool: "browser_check",
      args: JSON.stringify({ path: "ui/button.html" }),
      ok: true,
      summary: "Browser check passed: screenshot captured",
      ms: 900,
    });

    const res = await finishTool.handler(
      {
        summary: "UI button verified in browser",
      },
      env.ctx
    );

    assert.equal(res.ok, true);
    assert.equal(res.data.verified, true);
    assert.deepEqual(res.data.warnings, []);
    assert.match(res.summary, /Task completed and verified/);
    assert.equal(res.data.report.evidence.browserCheck?.ok, true);
  });

  await t.test("finish: warns when no plan was recorded without changing verified", async () => {
    // Clear the plan in the workspace
    await todoTool.handler({ action: "clear" }, env.ctx);

    const res = await finishTool.handler(
      {
        summary: "Task done with no plan recorded",
      },
      env.ctx
    );

    assert.equal(res.ok, true);
    assert.equal(res.data.verified, true);
    assert.ok(res.data.warnings.includes("no plan was recorded"));
  });

  await t.test("finish: warns when plan has unfinished steps without changing verified", async () => {
    // Set a plan with unfinished steps
    await todoTool.handler(
      {
        action: "set",
        items: [
          { text: "Done task", status: "done" },
          { text: "Pending task", status: "pending" },
          { text: "In progress task", status: "in_progress" },
        ],
      },
      env.ctx
    );

    const res = await finishTool.handler(
      {
        summary: "Task done with unfinished plan items",
      },
      env.ctx
    );

    assert.equal(res.ok, true);
    assert.equal(res.data.verified, true);
    assert.ok(
      res.data.warnings.some((w: string) =>
        w.includes("plan has 2 unfinished steps — update todo before finishing")
      )
    );
  });

  await t.test("todo: emits plan on board on set and update", async () => {
    const plansEmitted: any[] = [];
    const unsubscribe = env.board.subscribe((ev) => {
      if (ev.type === "plan") {
        plansEmitted.push(ev);
      }
    });

    await todoTool.handler(
      {
        action: "set",
        items: [
          { text: "First task", status: "pending" },
          { text: "Second task", status: "pending" },
        ],
      },
      env.ctx
    );

    assert.equal(plansEmitted.length, 1);
    assert.equal(plansEmitted[0].todos.length, 2);

    await todoTool.handler(
      {
        action: "update",
        id: "1",
        status: "done",
      },
      env.ctx
    );

    assert.equal(plansEmitted.length, 2);
    assert.equal(plansEmitted[1].todos[0].status, "done");

    unsubscribe();
  });

  await t.test("resume: returns open requests and last finish", async () => {
    // Add an open request
    await askUserTool.handler(
      {
        command: "npm run deploy",
        purpose: "Deploy to staging",
      },
      env.ctx
    );

    const res = await resumeTool.handler({}, env.ctx);
    assert.equal(res.ok, true);
    assert.ok(Array.isArray(res.data.open_requests));
    assert.equal(res.data.open_requests.length, 1);
    assert.equal(res.data.open_requests[0].command, "npm run deploy");
    assert.equal(res.data.open_requests[0].purpose, "Deploy to staging");

    assert.ok(res.data.last_finish);
    assert.equal(res.data.last_finish.verified, true);
    assert.match(res.summary, /open user request/);
    assert.match(res.summary, /last finish:/);
  });
});

test("finish evidence ignores runs recorded in another workspace", async () => {
  const { collectFinishEvidence } = await import("../src/tools/lib/evidence.js");
  const { createTestEnvironment } = await import("./helpers.js");
  const env = await createTestEnvironment();
  try {
    const ws = env.ctx.workspace.active();
    env.ctx.activity.record({ tool: "run", args: JSON.stringify({ verify: true }), ok: true, summary: "checks passed", ms: 1, workspace: "/somewhere/else" });
    const r = await collectFinishEvidence(env.ctx, ws);
    assert.equal(r.evidence.verify, undefined);
    assert.equal(r.verified, false);
    env.ctx.activity.record({ tool: "run", args: JSON.stringify({ verify: true }), ok: true, summary: "checks passed", ms: 1, workspace: ws });
    const r2 = await collectFinishEvidence(env.ctx, ws);
    assert.equal(r2.evidence.verify?.ok, true);
  } finally {
    await env.cleanup();
  }
});
