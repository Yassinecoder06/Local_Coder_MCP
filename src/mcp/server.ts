/**
 * Owned by agy1. Creates and configures per-session McpServer instances.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import toolModules from "../tools/index.js";
import { annotationsFor } from "../core/annotations.js";
import { fail, RESULT_OUTPUT_SCHEMA, toCallToolResult } from "../core/result.js";
import { getSettings } from "../core/settings.js";
import type { ToolContext, ToolResult } from "../core/types.js";
import { buildInstructions } from "./instructions.js";

/** Final list of tools included in the 'essential' profile. All others require 'full'. */
export const ESSENTIAL_TOOLS = new Set([
  "workspace_info",
  "workspace_switch",
  "read",
  "list",
  "search",
  "checkpoints",
  "edit_files",
  "run",
  "job",
  "git",
  "git_write",
  "skills_list",
  "skill_load",
  "skill_save",
  "commands_list",
  "command_run",
  "fetch_url",
  "status",
  "todo",
  "resume",
  "browser_check",
]);

function summarizeArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  try {
    const safe: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
      if (/token|password|secret|key|auth|bearer/i.test(k)) {
        safe[k] = "[REDACTED]";
      } else {
        safe[k] = v;
      }
    }
    const str = JSON.stringify(safe);
    return str.length > 200 ? str.slice(0, 197) + "..." : str;
  } catch {
    return "";
  }
}

export function inferClient(
  clientVersionName?: string,
  headers?: { userAgent?: string; origin?: string } | Record<string, string | string[] | undefined>
): string {
  if (clientVersionName && clientVersionName.trim().length > 0) {
    const trimmed = clientVersionName.trim();
    if (/token|password|secret|key|bearer/i.test(trimmed)) {
      return "unknown";
    }
    const lower = trimmed.toLowerCase();
    if (lower.includes("chatgpt") || lower.includes("openai")) return "chatgpt";
    if (lower.includes("gemini") || lower.includes("google")) return "gemini";
    return trimmed;
  }

  if (!headers) return "unknown";

  let userAgent = "";
  let origin = "";
  if ("userAgent" in headers || "origin" in headers) {
    const h = headers as { userAgent?: string; origin?: string };
    userAgent = h.userAgent ?? "";
    origin = h.origin ?? "";
  } else {
    const raw = headers as Record<string, string | string[] | undefined>;
    userAgent = String(raw["user-agent"] ?? raw["User-Agent"] ?? "");
    origin = String(raw["origin"] ?? raw["Origin"] ?? "");
  }

  const combined = `${userAgent} ${origin}`.toLowerCase();
  if (combined.includes("chatgpt") || combined.includes("openai")) {
    return "chatgpt";
  }
  if (combined.includes("gemini") || combined.includes("google")) {
    return "gemini";
  }
  return "unknown";
}

export async function createMcpServer(
  ctx: ToolContext,
  sessionId?: string,
  getHeaders?: () => { userAgent?: string; origin?: string } | undefined
): Promise<McpServer> {
  const instructions = await buildInstructions(ctx);
  const server = new McpServer(
    { name: "local-coder-mcp", version: ctx.config.version },
    { instructions }
  );

  const settings = getSettings();
  const profile = settings.toolProfile ?? ctx.config.toolProfile;
  const approvalMode = settings.approvalMode ?? ctx.config.approvalMode;
  const disabledTools = new Set(settings.disabledTools);

  // Flatten tool definitions from all imported modules
  const allTools = (toolModules ?? []).flat();

  for (const tool of allTools) {
    if (!tool || !tool.name) continue;
    if (disabledTools.has(tool.name)) continue;
    if (profile === "essential" && !ESSENTIAL_TOOLS.has(tool.name)) continue;

    const annotations = annotationsFor(tool.risk, tool.title, approvalMode);

    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        outputSchema: RESULT_OUTPUT_SCHEMA,
        annotations,
      },
      async (args: any, extra: any) => {
        const start = Date.now();
        let res: ToolResult;
        try {
          res = await tool.handler(args, ctx);
        } catch (err) {
          res = fail(tool.name, err);
        }
        const ms = Date.now() - start;

        // Activity logging
        const clientVersion = server.server.getClientVersion();
        const headers = extra?.requestInfo?.headers ?? getHeaders?.();
        const client = inferClient(clientVersion?.name, headers);
        const sid = (extra?.sessionId || sessionId || "").slice(0, 8) || undefined;

        ctx.activity.record({
          session: sid,
          client,
          tool: tool.name,
          args: summarizeArgs(args),
          ok: res.ok,
          summary: res.summary || (res.ok ? "OK" : res.error || "Failed"),
          ms,
        });

        return toCallToolResult(res, ctx.config.maxOutputBytes);
      }
    );
  }

  // Register commands as MCP prompts
  try {
    const commands = await ctx.commands.list();
    for (const cmd of commands) {
      const argsSchema: Record<string, z.ZodString> = {};
      for (const arg of cmd.args ?? []) {
        argsSchema[arg] = z.string().describe(`Argument: ${arg}`);
      }
      server.registerPrompt(
        cmd.name,
        {
          title: cmd.name,
          description: cmd.description,
          argsSchema: Object.keys(argsSchema).length > 0 ? argsSchema : undefined,
        },
        async (args) => {
          const rendered = await ctx.commands.render(cmd.name, (args ?? {}) as Record<string, string>);
          return {
            messages: [
              {
                role: "user" as const,
                content: { type: "text" as const, text: rendered },
              },
            ],
          };
        }
      );
    }
  } catch (err) {
    console.warn("[mcp] Failed to register commands as prompts:", err);
  }

  // Register enabled skills as MCP resources
  try {
    const skills = await ctx.skills.list({ includeDisabled: false, workspaceRoot: ctx.workspace.active() });
    for (const sk of skills) {
      const uri = `skill://${sk.name}`;
      server.registerResource(
        sk.name,
        uri,
        {
          title: sk.name,
          description: sk.description,
          mimeType: "text/markdown",
        },
        async () => {
          const s = await ctx.skills.get(sk.name, ctx.workspace.active());
          return {
            contents: [
              {
                uri,
                mimeType: "text/markdown",
                text: s?.body ?? "",
              },
            ],
          };
        }
      );
    }
  } catch (err) {
    console.warn("[mcp] Failed to register skills as resources:", err);
  }

  // Ensure request handlers for tools, prompts, and resources are always initialized even with 0 items
  (server as any).setToolRequestHandlers();
  (server as any).setPromptRequestHandlers();
  (server as any).setResourceRequestHandlers();

  return server;
}
