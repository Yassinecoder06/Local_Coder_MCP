import test from "node:test";
import assert from "node:assert/strict";
import { createTestEnvironment } from "./helpers.js";
import { runTool, jobTool, jobStopTool } from "../src/tools/shell.js";

test("shell tools: run sync, run background, job status/output, job_stop", async (t) => {
  const env = await createTestEnvironment({ shellSyncMs: 500 });

  t.after(async () => {
    await env.cleanup();
  });

  await t.test("run synchronous command", async () => {
    const res = await runTool.handler({ command: "echo 'hello sync'" }, env.ctx);
    assert.equal(res.ok, true);
    assert.equal(res.data.exit_code, 0);
    assert.match(res.data.output, /hello sync/);
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

    // Stop job
    const stopRes = await jobStopTool.handler({ job_id: jobId }, env.ctx);
    assert.equal(stopRes.ok, true);
    assert.equal(stopRes.data.stopped, true);

    // Wait a brief moment and verify stopped
    await new Promise((r) => setTimeout(r, 100));
    const statusAfter = await jobTool.handler({ action: "status", job_id: jobId }, env.ctx);
    assert.equal(statusAfter.data.running, false);
  });
});
