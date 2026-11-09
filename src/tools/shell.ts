import { z } from "zod";
import { defineTool, type ToolModule } from "../core/types.js";
import { ok, fail } from "../core/result.js";
import { jobManager, type RunResult } from "./lib/jobs.js";
import { detectChecks, parseCheckErrors, type CheckResult } from "./lib/verify.js";

export const BROWSER_CHECK_TIP =
  "Tip: use browser_check for headless browser checks (screenshot + console); raw Chromium may crash in the container.";

export const DIRECT_BROWSER_RE =
  /\b(chromium|chromium-browser|google-chrome|playwright|puppeteer)\b/i;

const CHROMIUM_MENTION_RE = /\b(chromium|chrome)\b/i;

export const runTool = defineTool({
  name: "run",
  title: "Run Shell Command",
  description: "Run a bash shell command or stop a background job via stop_job_id. Call run with verify:true after changes, and before saying a task is done. Commands returning within sync timeout return output immediately; longer processes continue in background as jobs.",
  group: "shell",
  risk: "exec",
  input: {
    command: z
      .string()
      .optional()
      .describe("Shell command string to execute in bash (required unless stop_job_id or verify is provided)"),
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

      if (args.verify && !args.command) {
        const cwd = ctx.workspace.resolve(args.cwd);
        const syncMs = ctx.config.shellSyncMs;
        const timeoutMs = args.timeout_ms ?? ctx.config.shellTimeoutMs;
        const detected = await detectChecks(cwd);

        if (detected.length === 0) {
          return ok("run", "No verification checks detected for this workspace", {
            checks: [],
            summary: "No verification checks detected",
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
          const tail = lines.slice(-20).join("\n");

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
            : `${failed.length} of ${results.length} failed: ${failed.map((f) => f.name).join(", ")}`;

        return ok("run", summary, {
          checks: results,
          summary,
          ok: failed.length === 0,
        });
      }

      if (!args.command) {
        return fail("run", "Either command, verify:true, or stop_job_id must be provided");
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
  description: "Check status, stream output, or list running background jobs spawned by run. Use action 'status', 'output', or 'list'.",
  group: "shell",
  risk: "read",
  input: {
    action: z
      .enum(["status", "output", "list"])
      .default("status")
      .optional()
      .describe("Action to perform: status, output, or list"),
    job_id: z.string().optional().describe("Job ID (required for status and output)"),
    limit: z.number().int().optional().describe("Maximum output bytes to return for output action"),
  },
  handler: async (args, ctx) => {
    try {
      const action = args.action ?? (args.job_id ? "status" : "list");

      if (action === "list" || !args.job_id) {
        const jobs = jobManager.listJobs();
        return ok("job", `Active/recent background jobs: ${jobs.length}`, { jobs });
      }

      if (action === "status") {
        const job = jobManager.getJob(args.job_id);
        if (!job) return fail("job", `Job "${args.job_id}" not found`);

        return ok("job", `Job ${args.job_id}: ${job.running ? "running" : `finished (code ${job.exitCode})`}`, {
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
        });
      }

      if (action === "output") {
        const output = jobManager.getJobOutput(args.job_id, args.limit);
        const job = jobManager.getJob(args.job_id);
        return ok("job", `Output for job ${args.job_id} (${output.length} chars)`, {
          job_id: args.job_id,
          running: job?.running ?? false,
          output,
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
