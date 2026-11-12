import { z } from "zod";
import { defineTool, type ToolModule } from "../core/types.js";
import { ok, fail } from "../core/result.js";
import { runCodeMode } from "./lib/code-mode.js";
import { PLAN_NUDGE_HINT } from "./lib/memory.js";

export const execTool = defineTool({
  name: "exec",
  title: "Execute Code Mode",
  description:
    "Execute a JavaScript script to batch multiple tool calls in a single turn. Has top-level await, tools.<name>(args), plugins.<id>.<tool>(args), ALL_TOOLS, PLUGINS, text(value), and image(val). " +
    "Return shapes: read → data.files[i].content; run(command) → data.output / data.exit_code; run(cmds) → data.items[i].output; job → data.output; plugins → summary / data.text. " +
    "Call plugin_tools first to inspect available plugins and schemas. " +
    'Example: const [a, b] = await Promise.all([tools.read({ paths: ["package.json"] }), tools.git({ subcommand: "status" })]); text(a.summary); text(b.data);',
  group: "system",
  risk: "exec",
  input: {
    code: z
      .string()
      .max(64000)
      .describe(
        "JavaScript code to execute (max 64,000 characters). Has top-level await, tools.<name>(args), plugins.<id>.<tool>(args), ALL_TOOLS, PLUGINS, text(val), and image(val)."
      ),
    timeout_ms: z
      .number()
      .int()
      .min(100)
      .max(180000)
      .optional()
      .describe("Execution timeout in milliseconds (default 60,000 ms, max 180,000 ms)"),
  },
  handler: async (args, ctx) => {
    if (!ctx.callTool) {
      return fail("exec", "Tool execution context is not available (callTool is not configured)");
    }

    const callable = ctx.callableTools ? ctx.callableTools() : [];

    const pluginList = ctx.plugins
      ? ctx.plugins.list().map((pt) => ({
          plugin: pt.plugin,
          tool: pt.name,
          description: pt.description,
          execAllowed: pt.execAllowed,
        }))
      : [];

    const pluginIds = new Set(pluginList.map((p) => p.plugin));
    const resolvePluginId = (id: string): string => {
      if (pluginIds.has(id)) return id;
      const withHyphens = id.replace(/_/g, "-");
      if (pluginIds.has(withHyphens)) return withHyphens;
      const withUnderscores = id.replace(/-/g, "_");
      if (pluginIds.has(withUnderscores)) return withUnderscores;
      return id.includes("_") ? id.replace(/_/g, "-") : id;
    };

    const callPluginTool = ctx.plugins
      ? async (plugin: string, tool: string, pluginArgs: Record<string, unknown>) => {
          const resolved = resolvePluginId(plugin);
          return await ctx.plugins!.call(resolved, tool, pluginArgs);
        }
      : undefined;

    let planNudged = false;
    const callTool = async (toolName: string, toolArgs: Record<string, unknown>) => {
      const toolRes = await ctx.callTool!(toolName, toolArgs);
      if ((toolRes as any)?.__planNudgeApplied || (typeof toolRes.summary === "string" && toolRes.summary.includes(PLAN_NUDGE_HINT))) {
        planNudged = true;
      }
      return toolRes;
    };

    const budgetTimeout = ctx.callBudgetMs ? Math.max(100, ctx.callBudgetMs - 500) : undefined;
    const result = await runCodeMode({
      code: args.code,
      timeoutMs: args.timeout_ms ?? budgetTimeout,
      callableTools: callable,
      callTool,
      plugins: pluginList,
      callPluginTool,
    });

    if (!result.ok) {
      const budgetSeconds = budgetTimeout ? Math.round(budgetTimeout / 1000) : 0;
      const error = !args.timeout_ms && budgetTimeout && result.error.includes("timed out")
        ? `exec stopped at ~${budgetSeconds}s to stay inside ${ctx.clientKind ?? "client"}'s tool time limit; start long commands with run (it returns a job_id) and poll with job`
        : result.error;
      return fail("exec", error);
    }

    let summary = `Executed code with ${result.totalCalls} tool call${result.totalCalls === 1 ? "" : "s"}`;
    if (planNudged) {
      summary += `\n${PLAN_NUDGE_HINT}`;
    }
    return {
      ok: true,
      tool: "exec",
      summary,
      data: {
        text: result.text,
        tool_calls_count: result.totalCalls,
      },
      images: result.images && result.images.length > 0 ? result.images : undefined,
    };
  },
});

const tools: ToolModule = [execTool];
export default tools;
