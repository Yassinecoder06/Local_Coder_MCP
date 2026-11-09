import { z } from "zod";
import { defineTool, type ToolModule } from "../core/types.js";
import { ok, fail } from "../core/result.js";
import { runCodeMode } from "./lib/code-mode.js";

export const execTool = defineTool({
  name: "exec",
  title: "Execute Code Mode",
  description:
    "Execute a JavaScript script to batch multiple tool calls in a single turn. Has top-level await, tools.<name>(args) returning ToolResult, ALL_TOOLS, text(value), and image(val). " +
    'Example: const [a, b] = await Promise.all([tools.read({ paths: ["package.json"] }), tools.git({ subcommand: "status" })]); text(a.summary); text(b.data);',
  group: "system",
  risk: "exec",
  input: {
    code: z
      .string()
      .max(64000)
      .describe(
        "JavaScript code to execute (max 64,000 characters). Has top-level await, tools.<name>(args), ALL_TOOLS, text(val), and image(val)."
      ),
    timeout_ms: z
      .number()
      .int()
      .min(100)
      .max(60000)
      .optional()
      .describe("Execution timeout in milliseconds (default 60,000 ms)"),
  },
  handler: async (args, ctx) => {
    if (!ctx.callTool) {
      return fail("exec", "Tool execution context is not available (callTool is not configured)");
    }

    const callable = ctx.callableTools ? ctx.callableTools() : [];

    const result = await runCodeMode({
      code: args.code,
      timeoutMs: args.timeout_ms,
      callableTools: callable,
      callTool: ctx.callTool,
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
