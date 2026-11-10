import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { createTestEnvironment } from "./helpers.js";
import { runTool, jobTool } from "../src/tools/shell.js";
import { jobManager } from "../src/tools/lib/jobs.js";

test("shell tools: run sync, run background, job status/output, run with stop_job_id", async (t) => {
  const env = await createTestEnvironment({ shellSyncMs: 500 });

  t.after(async () => {
    for (const service of await jobManager.listServices()) {
      if (service.running) jobManager.stopService(String(service.name));
    }
    await env.cleanup();
  });

  await t.test("run synchronous command", async () => {
    const res = await runTool.handler({ command: "echo 'hello sync'" }, env.ctx);
    assert.equal(res.ok, true);
    assert.equal(res.data.exit_code, 0);
    assert.match(res.data.output, /hello sync/);
    assert.ok(!res.summary.includes("Tip: use browser_check"));
  });

  await t.test("applies the client call budget to the synchronous shell window", async () => {
    env.ctx.callBudgetMs = 80;
    const res = await runTool.handler({ command: "sleep 0.3" }, env.ctx);
    assert.equal(res.ok, true);
    assert.equal(res.data.running, true);
    await runTool.handler({ stop_job_id: res.data.job_id }, env.ctx);
    env.ctx.callBudgetMs = undefined;
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

  await t.test("reports a promoted batch honestly and keeps its remaining commands in the job", async () => {
    const res = await runTool.handler({
      cmds: ["echo batch-first", "sleep 2; echo batch-second", "echo batch-third"],
    }, env.ctx);
    assert.equal(res.ok, true);
    assert.equal(res.data.running, true);
    assert.equal(res.data.items[0].status, "completed");
    assert.match(res.data.items[1].status, new RegExp(`running \\(index 2\\) in job ${res.data.job_id}`));
    assert.equal(res.data.items[2].status, "pending");
    assert.match(res.data.items[0].output, /batch-first/);

    const status = await jobTool.handler({ action: "status", job_id: res.data.job_id }, env.ctx);
    assert.equal(status.data.batch_progress.current_index, 2);
    assert.equal(status.data.batch_progress.commands[0].status, "completed");
    assert.equal(status.data.batch_progress.commands[1].status, "running");
    assert.match(status.summary, /batch current index 2/);
    const laterOutput = await jobTool.handler({ action: "poll", job_id: res.data.job_id, wait_ms: 5000 }, env.ctx);
    const finalOutput = await jobTool.handler({ action: "poll", job_id: res.data.job_id, wait_ms: 1000 }, env.ctx);
    assert.match(`${laterOutput.data.output}${finalOutput.data.output}`, /batch-third/);
  });

  await t.test("starts, lists, logs, restarts, and stops a named service with port health", async () => {
    const reservation = net.createServer();
    await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
    const port = (reservation.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const command = `node -e 'const net=require("node:net");const s=net.createServer();s.listen(${port},"127.0.0.1",()=>console.log("service-ready"));setInterval(()=>{},1000)'`;

    const started = await runTool.handler({ service: "dev-test", command, port }, env.ctx);
    assert.equal(started.ok, true);
    assert.equal(started.data.running, true);
    assert.match(started.data.output, /service-ready/);
    assert.equal(started.data.port, port);

    const services = await jobTool.handler({ action: "services" }, env.ctx);
    assert.ok(services.data.services.some((service: any) => service.name === "dev-test" && service.port_healthy));
    const logs = await jobTool.handler({ action: "logs", service: "dev-test", lines: 10 }, env.ctx);
    assert.match(logs.summary, /service-ready/);

    const restarted = await jobTool.handler({ action: "restart", service: "dev-test" }, env.ctx);
    assert.equal(restarted.data.running, true);
    assert.match(restarted.data.output, /service-ready/);
    const stopped = await jobTool.handler({ action: "stop", service: "dev-test" }, env.ctx);
    assert.equal(stopped.data.stopped, true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const afterStop = await jobTool.handler({ action: "services" }, env.ctx);
    assert.equal(afterStop.data.services.find((service: any) => service.name === "dev-test").running, false);
  });

  await t.test("caps retained service output at 256 KB", async () => {
    const started = await runTool.handler({
      service: "buffer-test",
      command: `node -e 'process.stdout.write("x".repeat(300000));setInterval(()=>{},1000)'`,
    }, env.ctx);
    assert.equal(started.data.running, true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const logs = await jobTool.handler({ action: "logs", service: "buffer-test", lines: 1 }, env.ctx);
    assert.ok(Buffer.byteLength(logs.data.output, "utf-8") <= 256 * 1024);
    await jobTool.handler({ action: "stop", service: "buffer-test" }, env.ctx);
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

  await t.test("stops a job through the job tool", async () => {
    const started = await runTool.handler({ command: "sleep 2" }, env.ctx);
    assert.equal(started.data.running, true);
    const stopped = await jobTool.handler({ action: "stop", job_id: started.data.job_id }, env.ctx);
    assert.equal(stopped.data.stopped, true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const status = await jobTool.handler({ action: "status", job_id: started.data.job_id }, env.ctx);
    assert.equal(status.data.running, false);
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
    assert.match(inputRes.summary, /got:hello/);
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
    assert.match(pollRes.summary, /poll-ready/);
    assert.equal(pollRes.data.running, true);
    const emptyPoll = await jobTool.handler({ action: "poll", job_id: jobId, wait_ms: 0 }, env.ctx);
    assert.match(emptyPoll.summary, /no new output yet \(running \d+s\)/);
    await runTool.handler({ stop_job_id: jobId }, env.ctx);

    const finishing = await runTool.handler({ command: "sleep 0.7; echo final-output; exit 7" }, env.ctx);
    assert.equal(finishing.data.running, true);
    const finalPoll = await jobTool.handler({ action: "poll", job_id: finishing.data.job_id, wait_ms: 2000 }, env.ctx);
    assert.match(finalPoll.summary, /final-output/);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const exitPoll = await jobTool.handler({ action: "poll", job_id: finishing.data.job_id, wait_ms: 0 }, env.ctx);
    assert.match(exitPoll.summary, /Job .* finished \(exit code 7\)/);
    assert.equal(exitPoll.data.exit_code, 7);
  });
});
