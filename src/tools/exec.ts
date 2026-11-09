import { z } from "zod";
import { defineTool, type ToolModule } from "../core/types.js";
import { ok, fail } from "../core/result.js";
import { runCodeMode } from "./lib/code-mode.js";

export const execTool = defineTool({
  name: "exec",
  title: "Execute Code Mode",
  description:
    "Execute a JavaScript script to batch multiple tool calls in a single turn. Has top-level await, tools.<name>(args), plugins.<id>.<tool>(args), ALL_TOOLS, PLUGINS, text(value), and image(val). " +
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

    const result = await runCodeMode({
      code: args.code,
      timeoutMs: args.timeout_ms,
      callableTools: callable,
      callTool: ctx.callTool,
      plugins: pluginList,
      callPluginTool,
    });

    if (!result.ok) {
      return fail("exec", result.error);
    }

    const summary = `Executed code with ${result.totalCalls} tool call${result.totalCalls === 1 ? "" : "s"}`;
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
