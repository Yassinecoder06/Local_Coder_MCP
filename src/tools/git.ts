import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { defineTool, type ToolModule } from "../core/types.js";
import { ok, fail } from "../core/result.js";

const execFileAsync = promisify(execFile);

const FORBIDDEN_READ_ARGS = [
  "--output",
  "-o",
  "--exec",
  "--upload-pack",
  "--receive-pack",
  "-u",
];

export const gitTool = defineTool({
  name: "git",
  title: "Git Read Operations",
  description: "Execute read-only git commands (status, diff, log, show, branch, blame). Non-destructive and safe.",
  group: "git",
  risk: "read",
  input: {
    subcommand: z
      .enum(["status", "diff", "log", "show", "branch", "blame"])
      .describe("Git read-only subcommand"),
    args: z
      .array(z.string())
      .default([])
      .optional()
      .describe("Arguments to pass to git (e.g. ['--staged', 'HEAD~1', '-n', '10'])"),
    path: z.string().optional().describe("Optional path filter"),
  },
  handler: async (args, ctx) => {
    try {
      const active = ctx.workspace.active();
      const subcommand = args.subcommand;
      const userArgs = args.args ?? [];

      // Validate safe read-only flags
      for (const arg of userArgs) {
        for (const forbidden of FORBIDDEN_READ_ARGS) {
          if (arg === forbidden || arg.startsWith(`${forbidden}=`)) {
            return fail("git", `Argument "${arg}" is not allowed in read-only git tool`);
          }
        }
      }

      const gitArgs = [subcommand, ...userArgs];
      if (args.path) {
        gitArgs.push("--", ctx.workspace.resolve(args.path));
      }

      const { stdout, stderr } = await execFileAsync("git", gitArgs, {
        cwd: active,
        maxBuffer: 10 * 1024 * 1024,
        env: {
          ...process.env,
          GIT_PAGER: "cat",
          PAGER: "cat",
        },
      });

      const output = (stdout + (stderr ? `\n${stderr}` : "")).trim();
      return ok("git", `git ${subcommand} (${output.split("\n").length} lines)`, {
        command: `git ${subcommand} ${userArgs.join(" ")}`.trim(),
        output,
        stdout,
      });
    } catch (err: any) {
      const stderr = err.stderr ? `\n${err.stderr}` : "";
      return fail("git", `${err.message}${stderr}`);
    }
  },
});

export const gitWriteTool = defineTool({
  name: "git_write",
  title: "Git Mutating Operations",
  description: "Execute mutating git commands (add, commit, checkout, switch, branch, restore, stash, pull, push, merge).",
  group: "git",
  risk: "exec",
  input: {
    subcommand: z
      .enum([
        "add",
        "commit",
        "checkout",
        "switch",
        "branch",
        "restore",
        "stash",
        "pull",
        "push",
        "merge",
      ])
      .describe("Git mutating subcommand"),
    args: z
      .array(z.string())
      .default([])
      .optional()
      .describe("Arguments to pass to git (e.g. ['-m', 'feat: update', '.'])"),
  },
  handler: async (args, ctx) => {
    try {
      const active = ctx.workspace.active();
      const subcommand = args.subcommand;
      const userArgs = args.args ?? [];

      const gitArgs = [subcommand, ...userArgs];

      const { stdout, stderr } = await execFileAsync("git", gitArgs, {
        cwd: active,
        maxBuffer: 10 * 1024 * 1024,
        env: {
          ...process.env,
          GIT_PAGER: "cat",
          PAGER: "cat",
        },
      });

      const output = (stdout + (stderr ? `\n${stderr}` : "")).trim();
      return ok("git_write", `git ${subcommand} succeeded`, {
        command: `git ${subcommand} ${userArgs.join(" ")}`.trim(),
        output,
        stdout,
        exit_code: 0,
      });
    } catch (err: any) {
      const stderr = err.stderr ? `\n${err.stderr}` : "";
      return fail("git_write", `${err.message}${stderr}`);
    }
  },
});

const tools: ToolModule = [gitTool, gitWriteTool];
export default tools;
