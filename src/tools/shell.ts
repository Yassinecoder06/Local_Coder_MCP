import { z } from "zod";
import { defineTool, type ToolModule } from "../core/types.js";
import { ok, fail } from "../core/result.js";
import { jobManager } from "./lib/jobs.js";

export const runTool = defineTool({
  name: "run",
  title: "Run Shell Command",
  description: "Run a bash shell command or stop a background job via stop_job_id. Commands returning within sync timeout return output immediately; longer processes continue in background as jobs.",
  group: "shell",
  risk: "exec",
  input: {
    command: z
      .string()
      .optional()
      .describe("Shell command string to execute in bash (required unless stop_job_id is provided)"),
    stop_job_id: z
      .string()
      .optional()
      .describe("Job ID of a running background job to terminate (alternative to command)"),
    signal: z
      .enum(["SIGTERM", "SIGKILL"])
      .default("SIGTERM")
      .optional()
      .describe("Signal to deliver when stopping a job via stop_job_id (default SIGTERM)"),
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

      if (!args.command) {
        return fail("run", "Either command or stop_job_id must be provided");
      }

      const cwd = ctx.workspace.resolve(args.cwd);
      const syncMs = ctx.config.shellSyncMs;
      const timeoutMs = args.timeout_ms ?? ctx.config.shellTimeoutMs;

      const result = await jobManager.startJob(args.command, cwd, syncMs, timeoutMs);

      if (!result.running) {
        const isOk = result.exit_code === 0;
        const summary = isOk
          ? `Command completed successfully (exit code 0)`
          : `Command exited with code ${result.exit_code}`;
        return ok("run", summary, {
          command: args.command,
          cwd: ctx.workspace.display(cwd),
          exit_code: result.exit_code,
          output: result.output,
        });
      }

      return ok("run", `Command is running in background (job_id: ${result.job_id})`, {
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
