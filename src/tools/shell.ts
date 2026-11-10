import { z } from "zod";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { defineTool, type ToolModule } from "../core/types.js";
import { ok, fail } from "../core/result.js";
import { jobManager, type RunResult } from "./lib/jobs.js";
import { detectChecks, noChecksMessage, parseCheckErrors, type CheckResult } from "./lib/verify.js";

export const BROWSER_CHECK_TIP =
  "Tip: use browser_check for headless browser checks (screenshot + console); raw Chromium may crash in the container.";

export const DIRECT_BROWSER_RE =
  /\b(chromium|chromium-browser|google-chrome|playwright|puppeteer)\b/i;

const CHROMIUM_MENTION_RE = /\b(chromium|chrome)\b/i;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function utf8Prefix(buffer: Buffer, maxBytes: number): string {
  let text = buffer.subarray(0, Math.max(0, maxBytes)).toString("utf-8");
  while (Buffer.byteLength(text, "utf-8") > maxBytes) text = text.slice(0, -1);
  return text;
}

function utf8Tail(value: string, maxBytes: number): string {
  let text = Buffer.from(value, "utf-8").subarray(-maxBytes).toString("utf-8");
  while (Buffer.byteLength(text, "utf-8") > maxBytes) text = text.slice(1);
  return text;
}

function buildBatchCommand(commands: string[], stopOnError: boolean, token: string): string {
  const state = `__lc_${token}`;
  const lines = ["set +e", `${state}_first=0`, `${state}_stop=${stopOnError ? 1 : 0}`];

  commands.forEach((command, index) => {
    const itemNumber = index + 1;
    const label = `[${itemNumber}/${commands.length}] $ ${command}`;
    lines.push(
      `if [ "$${state}_first" -eq 0 ] || [ "$${state}_stop" -eq 0 ]; then`,
      `  printf '%s\\n' ${shellQuote(label)}`,
      `  if eval ${shellQuote(command)}; then ${state}_status=0; else ${state}_status=$?; fi`,
      `  printf '\\n[${itemNumber}/${commands.length}] exit code: %s\\n' "$${state}_status"`,
      `  if [ "$${state}_status" -ne 0 ] && [ "$${state}_first" -eq 0 ]; then ${state}_first="$${state}_status"; fi`,
      "fi"
    );
  });

  lines.push(`exit "$${state}_first"`);
  return lines.join("\n");
}

function batchItems(
  commands: string[],
  capturedOutput: string,
  maxOutputBytes: number,
  stopOnError: boolean,
  running = false,
  jobId?: string,
  captureTruncated = false
): { cmd: string; exitCode: number | null; output: string; status: string; truncated?: boolean; skipped?: boolean }[] {
  let remainingBytes = Math.max(0, maxOutputBytes);
  let stopped = false;
  let cursor = 0;
  let runningIndex: number | null = null;

  return commands.map((cmd, index) => {
    const label = `[${index + 1}/${commands.length}] $ ${cmd}`;
    const exitLabel = `[${index + 1}/${commands.length}] exit code: `;
    const beginAt = capturedOutput.indexOf(label, cursor);
    const exitAt = beginAt < 0 ? -1 : capturedOutput.indexOf(exitLabel, beginAt + label.length);

    if (beginAt < 0) {
      if (stopped) {
        return { cmd, exitCode: null, output: "Skipped because stop_on_error was set.", status: "skipped", skipped: true };
      }
      if (captureTruncated && runningIndex === null) {
        return { cmd, exitCode: null, output: "Output unavailable because the job output ring buffer was exceeded.", status: "unknown (output capture limit)", truncated: true };
      }
      if (running && runningIndex === null) {
        runningIndex = index + 1;
        return {
          cmd, exitCode: null,
          output: `running (index ${index + 1}) in job ${jobId}`,
          status: `running (index ${index + 1}) in job ${jobId}`,
        };
      }
      if (running && runningIndex !== null) return { cmd, exitCode: null, output: "pending", status: "pending" };
      return { cmd, exitCode: null, output: "Output unavailable (the batch stopped or exceeded the capture limit).", status: "unavailable", truncated: true };
    }

    const endLineAt = exitAt < 0 ? -1 : capturedOutput.indexOf("\n", exitAt);
    if (exitAt < 0 || endLineAt < 0) {
      const outputBytes = Buffer.from(capturedOutput.slice(beginAt), "utf-8");
      const output = utf8Prefix(outputBytes, remainingBytes);
      remainingBytes = Math.max(0, remainingBytes - Buffer.byteLength(output, "utf-8"));
      const status = running ? `running (index ${index + 1}) in job ${jobId}` : "incomplete";
      if (running) runningIndex = index + 1;
      return { cmd, exitCode: null, output, status, truncated: true };
    }

    const statusText = capturedOutput.slice(exitAt + exitLabel.length, endLineAt);
    const exitCode = Number(statusText);
    if (!Number.isInteger(exitCode)) {
      return { cmd, exitCode: null, output: "Output unavailable (the batch output was truncated).", status: "unavailable", truncated: true };
    }
    if (stopOnError && exitCode !== 0) stopped = true;

    const outputEnd = endLineAt + 1;
    const outputBytes = Buffer.from(capturedOutput.slice(beginAt, outputEnd), "utf-8");
    const truncated = outputBytes.byteLength > remainingBytes;
    const output = utf8Prefix(outputBytes, remainingBytes);
    remainingBytes = Math.max(0, remainingBytes - Buffer.byteLength(output, "utf-8"));
    cursor = outputEnd;
    return { cmd, exitCode, output, status: "completed", ...(truncated ? { truncated: true } : {}) };
  });
}

export const runTool = defineTool({
  name: "run",
  title: "Run Shell Command",
  description: "Run one bash command or batch 1–20 commands in one shell with cmds; batched commands share directory and environment changes and report a separate exit code. Use service for dev servers; never use nohup or shell backgrounding (&). Other long commands continue as jobs. Use verify:true after changes, and stop_job_id to terminate a job.",
  group: "shell",
  risk: "exec",
  input: {
    command: z
      .string()
      .optional()
      .describe("Shell command string to execute in bash (required unless stop_job_id or verify is provided)"),
    cmds: z
      .array(z.string())
      .min(1)
      .max(20)
      .optional()
      .describe("Run 1–20 commands sequentially in one bash process; directory and environment changes carry over"),
    stop_on_error: z
      .boolean()
      .optional()
      .describe("For cmds batches, stop after the first non-zero command exit code"),
    stop_job_id: z
      .string()
      .optional()
      .describe("Job ID of a running background job to terminate (alternative to command)"),
    signal: z
      .enum(["SIGTERM", "SIGKILL"])
      .default("SIGTERM")
      .optional()
      .describe("Signal to deliver when stopping a job via stop_job_id (default SIGTERM)"),
    verify: z
      .boolean()
      .default(false)
      .optional()
      .describe("When true and command is empty, auto-detect and run project validation checks (typecheck, lint, test, build)"),
    cwd: z
      .string()
      .optional()
      .describe("Working directory for command execution (defaults to active workspace)"),
    timeout_ms: z
      .number()
      .int()
      .optional()
      .describe("Command timeout limit in milliseconds"),
    service: z.string().min(1).max(80).optional().describe("Name for a persistent long-running service; starting an existing name replaces that service"),
    port: z.number().int().min(1).max(65535).optional().describe("Optional local TCP port to watch for service readiness"),
  },
  handler: async (args, ctx) => {
    try {
      if (args.stop_job_id) {
        const stopped = jobManager.stopJob(args.stop_job_id, args.signal ?? "SIGTERM");
        return ok("run", `Sent ${args.signal ?? "SIGTERM"} to job ${args.stop_job_id}`, {
          job_id: args.stop_job_id,
          stopped,
        });
      }

      if (args.service !== undefined) {
        if (!args.command) return fail("run", "command is required when starting a service");
        if (args.cmds || args.verify) return fail("run", "service cannot be combined with cmds or verify:true");
        const cwd = ctx.workspace.resolve(args.cwd);
        const serviceWaitMs = Math.max(0, Math.min(2700, (ctx.callBudgetMs ?? 3200) - 500));
        const service = await jobManager.startService(args.service, args.command, cwd, args.port, serviceWaitMs);
        return ok("run", `Service "${args.service}" ${service.running ? "started" : `exited (code ${service.exitCode})`}`, {
          service: args.service,
          command: service.command,
          cwd: ctx.workspace.display(cwd),
          pid: service.pid,
          running: service.running,
          exit_code: service.exitCode,
          port: service.port ?? null,
          output: service.outputBuffer.join(""),
        });
      }
      if (args.port !== undefined) return fail("run", "port can only be used with service");

      if (args.command !== undefined && args.cmds !== undefined) {
        return fail("run", "Provide exactly one of command or cmds, not both");
      }

      if (args.verify && !args.command && !args.cmds) {
        const cwd = ctx.workspace.resolve(args.cwd);
        const syncMs = ctx.config.shellSyncMs;
        const timeoutMs = args.timeout_ms ?? ctx.config.shellTimeoutMs;
        const detected = await detectChecks(cwd);

        if (detected.length === 0) {
          const message = await noChecksMessage(cwd);
          return ok("run", message, {
            checks: [],
            summary: message,
            ok: true,
          });
        }

        const startTime = Date.now();
        const results: CheckResult[] = [];
        let backgroundJobResult: RunResult | null = null;

        for (let i = 0; i < detected.length; i++) {
          const check = detected[i];
          const elapsed = Date.now() - startTime;
          const remainingSync = Math.max(100, syncMs - elapsed);

          const checkStart = Date.now();
          const jobRes = await jobManager.startJob(check.command, cwd, remainingSync, timeoutMs);
          const duration_ms = Date.now() - checkStart;

          if (jobRes.running) {
            backgroundJobResult = jobRes;
            break;
          }

          const isOk = jobRes.exit_code === 0;
          const output = jobRes.output || "";
          const errors = parseCheckErrors(output);
          const lines = output.trim().split("\n");
          let tail = lines.slice(-20).join("\n");
          let missingDeps = false;
          if (!isOk && check.command.startsWith("npm ") &&
            /not found|not recognized|cannot find module|cannot find package|module not found|missing script dependency/i.test(output)) {
            try { await fs.access(path.join(cwd, "node_modules")); }
            catch { missingDeps = true; }
          }
          if (missingDeps) tail += `${tail ? "\n" : ""}dependencies not installed — run npm install`;

          results.push({
            name: check.name,
            command: check.command,
            ok: isOk,
            exit_code: jobRes.exit_code ?? (isOk ? 0 : 1),
            duration_ms,
            errors,
            tail,
          });
        }

        if (backgroundJobResult) {
          return ok(
            "run",
            `Verification check exceeded sync timeout and continues in background (job: ${backgroundJobResult.job_id})`,
            {
              running: true,
              job_id: backgroundJobResult.job_id,
              pid: backgroundJobResult.pid,
              output_so_far: backgroundJobResult.output_so_far,
              completed_checks: results,
              note: `Use 'job' tool with job_id "${backgroundJobResult.job_id}" to check status or output, and 'run' with stop_job_id to terminate.`,
            }
          );
        }

        const failed = results.filter((r) => !r.ok);
        const summary =
          failed.length === 0
            ? `All ${results.length} checks passed`
            : `${failed.length} of ${results.length} failed: ${failed.map((f) => f.name).join(", ")}${results.some((r) => r.tail.includes("dependencies not installed — run npm install")) ? "; dependencies not installed — run npm install" : ""}`;

        return ok("run", summary, {
          checks: results,
          summary,
          ok: failed.length === 0,
        });
      }

      if (args.cmds) {
        if (args.verify) return fail("run", "verify:true cannot be combined with cmds");

        const cwd = ctx.workspace.resolve(args.cwd);
        const syncMs = ctx.config.shellSyncMs;
        const timeoutMs = args.timeout_ms ?? ctx.config.shellTimeoutMs;
        const stopOnError = args.stop_on_error ?? false;
        const command = buildBatchCommand(args.cmds, stopOnError, randomUUID().replace(/-/g, ""));
        const result = await jobManager.startJob(command, cwd, syncMs, timeoutMs, { commands: args.cmds, stopOnError });
        const items = batchItems(args.cmds, result.output, ctx.config.maxOutputBytes, stopOnError, result.running, result.job_id, result.output_truncated);
        const isDirectBrowser = args.cmds.some((item) => DIRECT_BROWSER_RE.test(item));
        let summary = result.running
          ? `Command batch is running in background (job_id: ${result.job_id}); ${items.map((item, i) => `${i + 1}: ${item.status}`).join("; ")}`
          : result.exit_code === 0
            ? "Command batch completed successfully (exit code 0)"
            : `Command batch completed with exit code ${result.exit_code}`;

        if (isDirectBrowser) {
          const mentionsChromium = args.cmds.some((item) => CHROMIUM_MENTION_RE.test(item)) || CHROMIUM_MENTION_RE.test(result.output);
          summary = !result.running && result.exit_code !== 0 && mentionsChromium
            ? `WARNING: Direct Chromium execution failed (exit code ${result.exit_code}). ${BROWSER_CHECK_TIP}`
            : `${summary}. ${BROWSER_CHECK_TIP}`;
        }

        return ok("run", summary, {
          cwd: ctx.workspace.display(cwd),
          exit_code: result.exit_code,
          running: result.running,
          ...(result.running ? { job_id: result.job_id, pid: result.pid } : {}),
          items,
        });
      }

      if (!args.command) {
        return fail("run", "Provide exactly one of command or cmds, or use verify:true or stop_job_id");
      }

      const cwd = ctx.workspace.resolve(args.cwd);
      const syncMs = ctx.config.shellSyncMs;
      const timeoutMs = args.timeout_ms ?? ctx.config.shellTimeoutMs;

      const isDirectBrowser = args.command ? DIRECT_BROWSER_RE.test(args.command) : false;

      const result = await jobManager.startJob(args.command, cwd, syncMs, timeoutMs);

      if (!result.running) {
        const isOk = result.exit_code === 0;
        let summary = isOk
          ? `Command completed successfully (exit code 0)`
          : `Command exited with code ${result.exit_code}`;

        if (isDirectBrowser) {
          const mentionsChromium =
            CHROMIUM_MENTION_RE.test(args.command) ||
            CHROMIUM_MENTION_RE.test(result.output ?? "");
          if (!isOk && mentionsChromium) {
            summary = `WARNING: Direct Chromium execution failed (exit code ${result.exit_code}). ${BROWSER_CHECK_TIP}`;
          } else {
            summary = `${summary}. ${BROWSER_CHECK_TIP}`;
          }
        }

        return ok("run", summary, {
          command: args.command,
          cwd: ctx.workspace.display(cwd),
          exit_code: result.exit_code,
          output: result.output,
        });
      }

      let runningSummary = `Command is running in background (job_id: ${result.job_id})`;
      if (isDirectBrowser) {
        runningSummary = `${runningSummary}. ${BROWSER_CHECK_TIP}`;
      }

      return ok("run", runningSummary, {
        job_id: result.job_id,
        running: true,
        pid: result.pid,
        output_so_far: result.output_so_far,
        note: `Use 'job' tool with job_id "${result.job_id}" to check status or output, and 'run' with stop_job_id to terminate.`,
      });
    } catch (err) {
      return fail("run", err);
    }
  },
});

export const jobTool = defineTool({
  name: "job",
  title: "Background Job Status",
  description: "Check jobs and named services, read logs, send input, poll for new output, stop jobs or services, and restart services. Use services to list persistent dev servers and logs with either a service name or job_id.",
  group: "shell",
  risk: "read",
  input: {
    action: z
      .enum(["status", "output", "list", "stdin", "poll", "services", "logs", "stop", "restart"])
      .default("status")
      .optional()
      .describe("Action: status, output, list, stdin, poll, services, logs, stop, or restart"),
    job_id: z.string().optional().describe("Job ID for job actions, or as the stop target"),
    service: z.string().optional().describe("Named service for logs, stop, or restart"),
    limit: z.number().int().optional().describe("Maximum output bytes to return for output action"),
    lines: z.number().int().min(1).max(1000).optional().describe("Number of recent log lines to return (default 100)"),
    input: z.string().optional().describe("Text to write to the job's stdin (required for stdin; include a newline when appropriate)"),
    wait_ms: z.number().int().min(0).max(10_000).optional().describe("Wait up to 10 seconds for new output (stdin and poll actions)"),
  },
  handler: async (args, ctx) => {
    try {
      const action = args.action ?? (args.job_id ? "status" : "list");

      if (action === "list") {
        const jobs = jobManager.listJobs();
        return ok("job", `Active/recent background jobs: ${jobs.length}`, { jobs });
      }

      if (action === "services") {
        const services = await jobManager.listServices();
        return ok("job", `Named services: ${services.length}`, { services });
      }

      if (action === "logs") {
        if (args.service) {
          const service = jobManager.getService(args.service);
          if (!service) return fail("job", `Service "${args.service}" not found`);
          const logs = jobManager.getServiceOutput(args.service, args.lines ?? 100);
          return ok("job", `Logs for service "${args.service}" (${service.running ? "running" : `exit code ${service.exitCode}`}):\n${utf8Tail(logs, 8192)}`, {
            service: args.service, running: service.running, exit_code: service.exitCode, output: logs,
          });
        }
        if (!args.job_id) return fail("job", "service or job_id is required for logs action");
        const job = jobManager.getJob(args.job_id);
        if (!job) return fail("job", `Job "${args.job_id}" not found`);
        const logs = jobManager.getJobOutput(args.job_id).split(/\r?\n/).slice(-(args.lines ?? 100)).join("\n");
        return ok("job", `Logs for job ${args.job_id} (${job.running ? "running" : `exit code ${job.exitCode}`}):\n${utf8Tail(logs, 8192)}`, {
          job_id: args.job_id, running: job.running, exit_code: job.exitCode, output: logs,
        });
      }

      if (action === "stop") {
        if (args.service) {
          const stopped = jobManager.stopService(args.service);
          return ok("job", `${stopped ? "Stopped" : "Service was not running:"} service "${args.service}"`, { service: args.service, stopped });
        }
        if (!args.job_id) return fail("job", "service or job_id is required for stop action");
        const stopped = jobManager.stopJob(args.job_id);
        return ok("job", `${stopped ? "Stopped" : "Job was not running:"} job ${args.job_id}`, { job_id: args.job_id, stopped });
      }

      if (action === "restart") {
        if (!args.service) return fail("job", "service is required for restart action");
        const current = jobManager.getService(args.service);
        if (!current) return fail("job", `Service "${args.service}" not found`);
        const serviceWaitMs = Math.max(0, Math.min(2700, (ctx.callBudgetMs ?? 3200) - 500));
        const restarted = await jobManager.startService(current.name, current.command, current.cwd, current.port, serviceWaitMs);
        return ok("job", `Service "${restarted.name}" ${restarted.running ? "restarted" : `exited (code ${restarted.exitCode})`}`, {
          service: restarted.name, pid: restarted.pid, running: restarted.running,
          exit_code: restarted.exitCode, port: restarted.port ?? null, output: restarted.outputBuffer.join(""),
        });
      }

      if (!args.job_id) return fail("job", `job_id is required for ${action} action`);

      if (action === "status") {
        const job = jobManager.getJob(args.job_id);
        if (!job) return fail("job", `Job "${args.job_id}" not found`);
        const batchProgress = jobManager.batchProgress(args.job_id);
        const batchSummary = batchProgress
          ? `; batch current index ${batchProgress.current_index ?? "none"}: ${batchProgress.commands.map((item) => `${item.index} ${item.status}${item.exit_code === null ? "" : ` (exit ${item.exit_code})`}`).join("; ")}`
          : "";

        return ok("job", `Job ${args.job_id}: ${job.running ? "running" : `finished (code ${job.exitCode})`}${batchSummary}`, {
          job_id: job.id,
          command: job.command,
          cwd: ctx.workspace.display(job.cwd),
          started_at: job.startedAt,
          finished_at: job.finishedAt,
          running: job.running,
          exit_code: job.exitCode,
          signal: job.signal,
          pid: job.pid,
          output_bytes: job.totalBytes,
          batch_progress: batchProgress,
        });
      }

      if (action === "output") {
        const output = jobManager.getJobOutput(args.job_id, args.limit);
        await jobManager.waitForNewOutput(args.job_id);
        const job = jobManager.getJob(args.job_id);
        return ok("job", `Output for job ${args.job_id} (${output.length} chars)`, {
          job_id: args.job_id,
          running: job?.running ?? false,
          output,
        });
      }

      if (action === "stdin" || action === "poll") {
        if (action === "stdin") {
          if (args.input === undefined) return fail("job", "input is required for stdin action");
          const written = jobManager.writeJobStdin(args.job_id, args.input);
          if (!written) return fail("job", `Job "${args.job_id}" is not running or no longer accepts input`);
        }

        const output = await jobManager.waitForNewOutput(args.job_id, args.wait_ms ?? 0);
        const job = jobManager.getJob(args.job_id);
        const elapsed = job?.startedAt ? Math.max(0, Math.floor((Date.now() - Date.parse(job.startedAt)) / 1000)) : 0;
        const boundedOutput = utf8Tail(output, 8192);
        const completion = job && !job.running ? `\nJob finished (exit code ${job.exitCode})` : "";
        let summary = boundedOutput
          ? `${action === "stdin" ? `Input sent to job ${args.job_id}. ` : ""}New output from job ${args.job_id}:\n${boundedOutput}${completion}`
          : job?.running
            ? `${action === "stdin" ? `Input sent to job ${args.job_id}; ` : ""}no new output yet (running ${elapsed}s)`
            : `Job ${args.job_id} finished (exit code ${job?.exitCode ?? null}); no new output`;
        const batchProgress = jobManager.batchProgress(args.job_id);
        if (batchProgress) {
          summary += `\nBatch current index ${batchProgress.current_index ?? "none"}: ${batchProgress.commands.map((item) => `${item.index} ${item.status}${item.exit_code === null ? "" : ` (exit ${item.exit_code})`}`).join("; ")}`;
        }
        return ok("job", summary, {
          job_id: args.job_id,
          running: job?.running ?? false,
          exit_code: job?.exitCode ?? null,
          output,
          batch_progress: batchProgress,
        });
      }

      return fail("job", `Unknown action: ${action}`);
    } catch (err) {
      return fail("job", err);
    }
  },
});

const tools: ToolModule = [runTool, jobTool];
export default tools;
