import test from "node:test";
import assert from "node:assert/strict";
import { createTestEnvironment } from "./helpers.js";
import { runTool, jobTool } from "../src/tools/shell.js";

test("shell tools: run sync, run background, job status/output, run with stop_job_id", async (t) => {
  const env = await createTestEnvironment({ shellSyncMs: 500 });

  t.after(async () => {
    await env.cleanup();
  });

  await t.test("run synchronous command", async () => {
    const res = await runTool.handler({ command: "echo 'hello sync'" }, env.ctx);
    assert.equal(res.ok, true);
    assert.equal(res.data.exit_code, 0);
    assert.match(res.data.output, /hello sync/);
    assert.ok(!res.summary.includes("Tip: use browser_check"));
  });

  await t.test("appends browser_check hint when invoking chromium or playwright directly", async () => {
    // Succeeded command invoking chromium
    const okRes = await runTool.handler({ command: "echo 'mock chromium' && echo done" }, env.ctx);
    assert.equal(okRes.ok, true);
    assert.ok(okRes.summary.includes("Tip: use browser_check for headless browser checks (screenshot + console); raw Chromium may crash in the container."));

    // Failed command mentioning chromium gets prominent warning
    const failRes = await runTool.handler({ command: "sh -c 'echo chromium failed >&2; exit 1'" }, env.ctx);
    assert.equal(failRes.ok, true);
    assert.equal(failRes.data.exit_code, 1);
    assert.ok(failRes.summary.includes("WARNING: Direct Chromium execution failed"));
    assert.ok(failRes.summary.includes("Tip: use browser_check"));

    // Command invoking playwright directly appends hint
    const pwRes = await runTool.handler({ command: "echo 'playwright test mock'" }, env.ctx);
    assert.equal(pwRes.ok, true);
    assert.ok(pwRes.summary.includes("Tip: use browser_check"));
  });

  await t.test("runs cmds sequentially in one shell and preserves each exit code", async () => {
    const subdir = `${env.workspaceDir}/batch-subdir`;
    const { mkdir } = await import("node:fs/promises");
    await mkdir(subdir);

    const res = await runTool.handler({ cmds: [`cd '${subdir}'`, "pwd", "false", "echo continued"] }, env.ctx);
    assert.equal(res.ok, true);
    assert.equal(res.data.exit_code, 1);
    assert.deepEqual(res.data.items.map((item: any) => item.exitCode), [0, 0, 1, 0]);
    assert.match(res.data.items[0].output, /\[1\/4\] \$ cd/);
    assert.ok(res.data.items[1].output.includes(subdir));
    assert.match(res.data.items[3].output, /continued/);
  });

  await t.test("requires exactly one batch or command input", async () => {
    const res = await runTool.handler({ command: "echo one", cmds: ["echo two"] }, env.ctx);
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /exactly one of command or cmds/);
  });

  await t.test("cmds stop after the first error when requested", async () => {
    const res = await runTool.handler({ cmds: ["false", "echo should-not-run"], stop_on_error: true }, env.ctx);
    assert.equal(res.data.exit_code, 1);
    assert.deepEqual(res.data.items.map((item: any) => item.exitCode), [1, null]);
    assert.equal(res.data.items[1].skipped, true);
  });

  await t.test("run background job when exceeding sync window", async () => {
    // Command takes 2 seconds, but syncMs is 500ms
    const res = await runTool.handler({ command: "sleep 2; echo 'finished'" }, env.ctx);
    assert.equal(res.ok, true);
    assert.equal(res.data.running, true);
    const jobId = res.data.job_id;
    assert.ok(jobId);

    // Check status
    const statusRes = await jobTool.handler({ action: "status", job_id: jobId }, env.ctx);
    assert.equal(statusRes.ok, true);
    assert.equal(statusRes.data.job_id, jobId);
    assert.equal(statusRes.data.running, true);

    // List jobs
    const listRes = await jobTool.handler({ action: "list" }, env.ctx);
    assert.equal(listRes.ok, true);
    assert.ok(listRes.data.jobs.some((j: any) => j.id === jobId));

    // Stop job via run tool with stop_job_id
    const stopRes = await runTool.handler({ stop_job_id: jobId }, env.ctx);
    assert.equal(stopRes.ok, true);
    assert.equal(stopRes.data.stopped, true);

    // Wait a brief moment and verify stopped
    await new Promise((r) => setTimeout(r, 100));
    const statusAfter = await jobTool.handler({ action: "status", job_id: jobId }, env.ctx);
    assert.equal(statusAfter.data.running, false);
  });

  await t.test("writes stdin to an interactive job and returns its new output", async () => {
    const res = await runTool.handler({ command: "read line; echo got:$line" }, env.ctx);
    assert.equal(res.ok, true);
    assert.equal(res.data.running, true);
    const jobId = res.data.job_id;
    assert.ok(jobId);

    const inputRes = await jobTool.handler({ action: "stdin", job_id: jobId, input: "hello\n", wait_ms: 2000 }, env.ctx);
    assert.equal(inputRes.ok, true);
    assert.match(inputRes.data.output, /got:hello/);
    const pollRes = await jobTool.handler({ action: "poll", job_id: jobId, wait_ms: 1000 }, env.ctx);
    assert.equal(pollRes.data.running, false);
  });

  await t.test("poll waits for new output and returns before the job finishes", async () => {
    const res = await runTool.handler({ command: "sleep 1; echo poll-ready; sleep 2" }, env.ctx);
    assert.equal(res.data.running, true);
    const jobId = res.data.job_id;
    assert.ok(jobId);

    const startedAt = Date.now();
    const pollRes = await jobTool.handler({ action: "poll", job_id: jobId, wait_ms: 10_000 }, env.ctx);
    assert.ok(Date.now() - startedAt < 2_000);
    assert.match(pollRes.data.output, /poll-ready/);
    assert.equal(pollRes.data.running, true);
    await runTool.handler({ stop_job_id: jobId }, env.ctx);
  });
});
