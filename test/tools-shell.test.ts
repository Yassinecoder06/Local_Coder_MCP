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
});
