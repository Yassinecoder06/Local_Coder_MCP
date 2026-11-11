/**
 * Owned by agy2. Agent memory tools (todo, resume).
 *
 * NOTE: These tools only change the assistant's own internal scratch state
 * stored under DATA_DIR/agent/<workspace-hash>.json, never the user's workspace files.
 */
import { execFile } from "node:child_process";
import path from "node:path";
import { z } from "zod";
import { defineTool, type ToolModule, type ToolContext } from "../core/types.js";
import { ok, fail } from "../core/result.js";
import { jobManager } from "./lib/jobs.js";
import {
  getAgentMemory,
  saveAgentMemory,
  formatRelativeAge,
  findNewerWorkspacePlans,
  type TodoItem,
  type NewerWorkspacePlan,
} from "./lib/memory.js";

function formatNewerPlanSuggestion(p: NewerWorkspacePlan, ctx: ToolContext): string {
  const rel = ctx.workspace.display(p.workspace);
  const name = !rel.startsWith("..") && rel !== "." ? rel : path.basename(p.workspace);
  return `newer plan in ${name} (${p.age}) — workspace_switch there?`;
}

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
      .enum(["list", "get", "set", "update", "clear"])
      .default("list")
      .optional()
      .describe("Action to perform: 'list'/'get' returns items, 'set' replaces all items, 'update' changes status of an item by id, 'clear' empties the plan"),
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

      if (action === "clear") {
        memory.todos = [];
        await saveAgentMemory(ctx.config.dataDir, workspaceRoot, memory);
        ctx.board?.emitPlan(workspaceRoot, []);
        return ok("todo", "Cleared plan", { todos: [], updatedAt: memory.updatedAt });
      }

      if (action === "list" || action === "get") {
        const todos = memory.todos;
        const pending = todos.filter((t) => t.status === "pending").length;
        const inProgress = todos.filter((t) => t.status === "in_progress").length;
        const done = todos.filter((t) => t.status === "done").length;
        const age = formatRelativeAge(memory.updatedAt);
        const ageMs = Date.now() - (Date.parse(memory.updatedAt) || 0);
        const isOlderThan12h = ageMs > 12 * 3600 * 1000;
        const notAllDone = todos.length > 0 && todos.some((t) => t.status !== "done");
        const isStale = isOlderThan12h && notAllDone;

        const newerPlans = await findNewerWorkspacePlans(
          ctx.config.dataDir,
          workspaceRoot,
          memory.updatedAt
        );

        const parts: string[] = [];
        parts.push(
          `${todos.length} todo item(s) (${pending} pending, ${inProgress} in progress, ${done} done, updated ${age})`
        );

        if (isStale) {
          parts.push(
            `Plan is older than 12 h and not all done (updated ${age}). Suggest todo({ action: "clear" }) or re-setting it.`
          );
        }

        if (newerPlans.length > 0) {
          parts.push(newerPlans.map((p) => formatNewerPlanSuggestion(p, ctx)).join(" "));
        }

        const summary = parts.join(" ");

        return ok("todo", summary, {
          todos,
          updatedAt: memory.updatedAt,
          age,
          stale: isStale,
          ...(newerPlans.length > 0 ? { newer_plans: newerPlans } : {}),
        });
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
        ctx.board?.emitPlan(workspaceRoot, todos);
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
        ctx.board?.emitPlan(workspaceRoot, memory.todos);
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
      const planAge = formatRelativeAge(memory.updatedAt);
      const ageMs = Date.now() - (Date.parse(memory.updatedAt) || 0);
      const isOlderThan12h = ageMs > 12 * 3600 * 1000;
      const notAllDone = memory.todos.length > 0 && memory.todos.some((t) => t.status !== "done");
      const isStale = isOlderThan12h && notAllDone;

      const newerPlans = await findNewerWorkspacePlans(
        ctx.config.dataDir,
        workspaceRoot,
        memory.updatedAt
      );

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

      // 5. Open user requests and last finish (Phase 2 board)
      let openRequests: { id: string; purpose: string; command: string }[] = [];
      let lastFinish: { summary: string; verified: boolean } | null = null;

      if (ctx.board) {
        const open = await ctx.board.listRequests({ workspace: workspaceRoot, status: "open" });
        openRequests = open.map((r) => ({
          id: r.id,
          purpose: r.purpose,
          command: r.command,
        }));

        const finishes = await ctx.board.listFinishes({ workspace: workspaceRoot, limit: 1 });
        if (finishes.length > 0) {
          lastFinish = {
            summary: finishes[0].summary,
            verified: finishes[0].verified,
          };
        }
      }

      const pending = memory.todos.filter((t) => t.status !== "done").length;
      const reqPart = openRequests.length > 0 ? `, ${openRequests.length} open user request(s)` : "";
      const finishPart = lastFinish ? `, last finish: ${lastFinish.verified ? "verified" : "unverified"}` : "";
      const stalePart = isStale
        ? ` Plan is older than 12 h and not all done (updated ${planAge}). Suggest todo({ action: "clear" }) or re-setting it.`
        : "";
      const newerPart =
        newerPlans.length > 0
          ? ` ${newerPlans.map((p) => formatNewerPlanSuggestion(p, ctx)).join(" ")}`
          : "";
      const summary = `Active workspace: ${ctx.workspace.display(workspaceRoot)}. ${memory.todos.length} todo(s) (${pending} remaining, updated ${planAge}), git branch: ${git.branch ?? "none"}, ${jobs.length} running job(s)${reqPart}${finishPart}.${stalePart}${newerPart}`;

      return ok("resume", summary, {
        workspace: ctx.workspace.display(workspaceRoot),
        workspace_absolute: workspaceRoot,
        todos: memory.todos,
        updatedAt: memory.updatedAt,
        plan_updated_at: memory.updatedAt,
        plan_age: planAge,
        stale_plan: isStale,
        ...(newerPlans.length > 0 ? { newer_plans: newerPlans } : {}),
        recent_activity: recentActivity,
        git,
        running_jobs: jobs,
        open_requests: openRequests,
        last_finish: lastFinish,
      });
    } catch (err) {
      return fail("resume", err);
    }
  },
});

const tools: ToolModule = [todoTool, resumeTool];
export default tools;
