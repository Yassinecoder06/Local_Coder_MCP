/**
 * Owned by agy2. Agent memory tools (todo, resume).
 *
 * NOTE: These tools only change the assistant's own internal scratch state
 * stored under DATA_DIR/agent/<workspace-hash>.json, never the user's workspace files.
 */
import { execFile } from "node:child_process";
import { z } from "zod";
import { defineTool, type ToolModule } from "../core/types.js";
import { ok, fail } from "../core/result.js";
import { jobManager } from "./lib/jobs.js";
import { getAgentMemory, saveAgentMemory, type TodoItem } from "./lib/memory.js";

function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, timeout: 5000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      (err, stdout) => {
        resolve(err ? "" : stdout.toString().trim());
      }
    );
  });
}

export const todoTool = defineTool({
  name: "todo",
  title: "Todo & Plan Memory",
  description: "Keep a plan for multi-step tasks and update it as you go. Survives reconnects and new sessions. Only modifies internal assistant scratch state, never project files.",
  group: "workspace",
  risk: "read",
  input: {
    action: z
      .enum(["list", "set", "update"])
      .default("list")
      .optional()
      .describe("Action to perform: 'list' returns items, 'set' replaces all items, 'update' changes status of an item by id"),
    items: z
      .array(
        z.object({
          id: z.string().optional().describe("Unique item ID (e.g. '1', '2'; auto-assigned if omitted)"),
          text: z.string().describe("Task description"),
          status: z
            .enum(["pending", "in_progress", "done"])
            .default("pending")
            .optional()
            .describe("Status: pending, in_progress, or done"),
        })
      )
      .optional()
      .describe("Full list of todo items when using action 'set'"),
    id: z
      .string()
      .optional()
      .describe("ID of the todo item to update when using action 'update'"),
    status: z
      .enum(["pending", "in_progress", "done"])
      .optional()
      .describe("New status ('pending', 'in_progress', or 'done') when using action 'update'"),
  },
  handler: async (args, ctx) => {
    try {
      const workspaceRoot = ctx.workspace.active();
      const memory = await getAgentMemory(ctx.config.dataDir, workspaceRoot);
      const action = args.action ?? "list";

      if (action === "list") {
        const todos = memory.todos;
        const pending = todos.filter((t) => t.status === "pending").length;
        const inProgress = todos.filter((t) => t.status === "in_progress").length;
        const done = todos.filter((t) => t.status === "done").length;
        const summary = `${todos.length} todo item(s) (${pending} pending, ${inProgress} in progress, ${done} done)`;
        return ok("todo", summary, { todos });
      }

      if (action === "set") {
        const rawItems = args.items ?? [];
        const todos: TodoItem[] = rawItems.map((item, idx) => ({
          id: item.id && item.id.trim().length > 0 ? item.id.trim() : String(idx + 1),
          text: item.text,
          status: item.status ?? "pending",
        }));
        memory.todos = todos;
        await saveAgentMemory(ctx.config.dataDir, workspaceRoot, memory);
        return ok("todo", `Set ${todos.length} todo item(s)`, { todos });
      }

      if (action === "update") {
        if (!args.id) {
          return fail("todo", "id is required for 'update' action");
        }
        if (!args.status) {
          return fail("todo", "status is required for 'update' action");
        }

        const target = memory.todos.find(
          (t) => t.id === args.id || t.id.toLowerCase() === args.id?.toLowerCase()
        );
        if (!target) {
          return fail("todo", `Todo item with id "${args.id}" not found`);
        }

        target.status = args.status;
        await saveAgentMemory(ctx.config.dataDir, workspaceRoot, memory);
        return ok("todo", `Updated todo "${target.text}" status to ${args.status}`, {
          updated_item: target,
          todos: memory.todos,
        });
      }

      return fail("todo", `Unknown action: ${action}`);
    } catch (err) {
      return fail("todo", err);
    }
  },
});

export const resumeTool = defineTool({
  name: "resume",
  title: "Resume Ongoing Work",
  description: "Call first when the user says continue or starts a new session about ongoing work. Returns active workspace, todo plan, recent activity, git status, and running background jobs.",
  group: "workspace",
  risk: "read",
  input: {
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(15)
      .optional()
      .describe("Maximum number of recent activity log entries to return (default 15)"),
  },
  handler: async (args, ctx) => {
    try {
      const workspaceRoot = ctx.workspace.active();

      // 1. Todo plan
      const memory = await getAgentMemory(ctx.config.dataDir, workspaceRoot);

      // 2. Recent activity
      const activityLimit = args.limit ?? 15;
      const recentActivity = await ctx.activity.recent(activityLimit);

      // 3. Git status and diff --stat
      const branch = await runGit(["branch", "--show-current"], workspaceRoot);
      const statusOut = await runGit(["status", "--short"], workspaceRoot);
      const diffStat = await runGit(["diff", "--stat"], workspaceRoot);
      const git = {
        is_git: branch.length > 0 || statusOut.length > 0 || diffStat.length > 0,
        branch: branch || null,
        status: statusOut || "(clean)",
        diff_stat: diffStat || "(clean)",
      };

      // 4. Running jobs
      const jobs = jobManager.listJobs().filter((j) => j.running);

      const pending = memory.todos.filter((t) => t.status !== "done").length;
      const summary = `Active workspace: ${ctx.workspace.display(workspaceRoot)}. ${memory.todos.length} todo(s) (${pending} remaining), git branch: ${git.branch ?? "none"}, ${jobs.length} running job(s).`;

      return ok("resume", summary, {
        workspace: ctx.workspace.display(workspaceRoot),
        workspace_absolute: workspaceRoot,
        todos: memory.todos,
        recent_activity: recentActivity,
        git,
        running_jobs: jobs,
      });
    } catch (err) {
      return fail("resume", err);
    }
  },
});

const tools: ToolModule = [todoTool, resumeTool];
export default tools;
