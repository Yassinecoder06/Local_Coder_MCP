/**
 * Owned by agy1. Creates and configures per-session McpServer instances.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import toolModules from "../tools/index.js";
import { annotationsFor } from "../core/annotations.js";
import { fail, RESULT_OUTPUT_SCHEMA, toCallToolResult } from "../core/result.js";
import { getSettings } from "../core/settings.js";
import type { ToolContext, ToolResult, PluginBridge } from "../core/types.js";
import type { PluginHub, PluginTool } from "../core/plugins.js";
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
  "exec",
  "job",
  "git",
  "git_write",
  "skills_list",
  "skill_load",
  "skill_save",
  "commands_list",
  "command_run",
  "fetch_url",
  "browser_check",
  "status",
  "todo",
  "resume",
  "ask_user",
  "user_request_status",
  "finish",
  "plugin_tools",
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

function unknownToolHint(name: string, names: string[]): string {
  const editAliases = new Set(["edit", "apply_patch", "write", "patch"]);
  if (editAliases.has(name)) {
    return `Unknown tool: ${name}. Use tools.edit_files({ ops: [...] }), for example tools.edit_files({ ops: [{ op: "patch", path: "src/file.ts", patch: "@@\\n-old\\n+new" }] }).`;
  }
  const distance = (a: string, b: string) => {
    const row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let prev = row[0]; row[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const old = row[j];
        row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = old;
      }
    }
    return row[b.length];
  };
  const closest = names.map((candidate) => ({ candidate, score: distance(name, candidate) }))
    .sort((a, b) => a.score - b.score).slice(0, 3).map(({ candidate }) => candidate);
  return `Unknown tool: ${name}. Closest tools: ${closest.join(", ")}.`;
}

function classifyClient(text: string): string | undefined {
  const lower = text.toLowerCase();

  // claude-code vs claude
  if (lower.includes("claude-code") || lower.includes("claude_code")) return "claude-code";
  if (lower.includes("claude") || lower.includes("anthropic")) return "claude";

  // gemini-cli vs gemini web
  if (lower.includes("gemini-cli") || lower.includes("gemini_cli")) return "gemini-cli";
  if (lower.includes("gemini") || lower.includes("google")) return "gemini";

  // chatgpt
  if (lower.includes("chatgpt") || lower.includes("openai")) return "chatgpt";

  // cursor
  if (lower.includes("cursor")) return "cursor";

  // vscode
  if (lower.includes("visual studio code") || lower.includes("vscode") || lower.includes("vs code")) return "vscode";

  // windsurf
  if (lower.includes("windsurf") || lower.includes("codeium")) return "windsurf";

  // codex
  if (lower.includes("codex")) return "codex";

  // le chat / mistral
  if (lower.includes("le chat") || lower.includes("le-chat") || lower.includes("mistral")) return "le-chat";

  return undefined;
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
    const matched = classifyClient(trimmed);
    if (matched) return matched;
    // Anything else keeps its sanitised clientInfo name (never 'unknown' when a name exists)
    return trimmed.replace(/[\r\n\t]+/g, " ").slice(0, 50);
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

  const combined = `${userAgent} ${origin}`;
  const matched = classifyClient(combined);
  if (matched) return matched;

  return "unknown";
}

export async function createMcpServer(
  ctx: ToolContext,
  sessionId?: string,
  getHeaders?: () => { userAgent?: string; origin?: string } | undefined,
  hub?: PluginHub
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
  const toolMap = new Map<string, (typeof allTools)[number]>();
  for (const t of allTools) {
    if (t?.name) toolMap.set(t.name, t);
  }

  let currentExtra: any = undefined;

  // Provide ctx.callableTools
  ctx.callableTools = (): { name: string; description: string }[] => {
    const currentSettings = getSettings();
    const currentProfile = currentSettings.toolProfile ?? ctx.config.toolProfile;
    const currentDisabled = new Set(currentSettings.disabledTools);

    const list: { name: string; description: string }[] = [];
    for (const t of allTools) {
      if (!t || !t.name) continue;
      if (t.name === "exec") continue;
      if (currentDisabled.has(t.name)) continue;
      if (currentProfile === "essential" && !ESSENTIAL_TOOLS.has(t.name)) continue;
      list.push({ name: t.name, description: t.description });
    }
    return list;
  };

  // Provide ctx.callTool
  ctx.callTool = async (name: string, args: Record<string, unknown>): Promise<ToolResult> => {
    const start = Date.now();
    let res: ToolResult;

    if (name === "exec") {
      res = fail("exec", "Recursion refusal: cannot call exec from within callTool");
    } else {
      const currentSettings = getSettings();
      const currentProfile = currentSettings.toolProfile ?? ctx.config.toolProfile;
      const currentDisabled = new Set(currentSettings.disabledTools);
      const targetTool = toolMap.get(name);

      if (!targetTool) {
        res = fail(name, unknownToolHint(name, ctx.callableTools?.().map((tool) => tool.name) ?? [...toolMap.keys()]));
      } else if (currentDisabled.has(name)) {
        res = fail(name, `Tool is disabled: ${name}`);
      } else if (currentProfile === "essential" && !ESSENTIAL_TOOLS.has(name)) {
        res = fail(name, `Tool '${name}' is not available in profile '${currentProfile}'`);
      } else {
        const schema = targetTool.input instanceof z.ZodType ? targetTool.input : z.object(targetTool.input);
        const parsed = schema.safeParse(args ?? {});
        if (!parsed.success) {
          res = fail(name, `Invalid arguments for tool '${name}': ${parsed.error.message}`);
        } else {
          try {
            res = await targetTool.handler(parsed.data as any, ctx);
          } catch (err) {
            res = fail(name, err);
          }
        }
      }
    }

    const ms = Date.now() - start;
    const clientVersion = server.server.getClientVersion();
    const headers = currentExtra?.requestInfo?.headers ?? getHeaders?.();
    const client = inferClient(clientVersion?.name, headers);
    const sid = (currentExtra?.sessionId || sessionId || "").slice(0, 8) || undefined;

    ctx.activity.record({
      session: sid,
      client,
      workspace: ctx.workspace.active(),
      tool: name,
      args: summarizeArgs(args),
      ok: res.ok,
      summary: res.summary || (res.ok ? "OK" : res.error || "Failed"),
      ms,
      via: "exec",
    });

    return res;
  };

  // Provide ctx.plugins (PluginBridge) when a hub exists
  if (hub) {
    ctx.plugins = {
      list(): PluginTool[] {
        return hub.execTools();
      },
      async call(plugin: string, tool: string, args: Record<string, unknown>): Promise<ToolResult> {
        const start = Date.now();
        const clientVersion = server.server.getClientVersion();
        const headers = currentExtra?.requestInfo?.headers ?? getHeaders?.();
        const client = inferClient(clientVersion?.name, headers);
        const sid = (currentExtra?.sessionId || sessionId || "").slice(0, 8) || undefined;
        const workspace = ctx.workspace.active();
        const execTools = hub.execTools();
        const target = execTools.find(
          (t) =>
            (t.plugin === plugin || t.plugin.replace(/-/g, "_") === plugin.replace(/-/g, "_")) &&
            t.name === tool
        );

        const canonicalPlugin = target ? target.plugin : plugin;
        const activityTool = `${canonicalPlugin}.${tool}`;

        if (!target) {
          const res = fail(activityTool, `Plugin '${plugin}' or tool '${tool}' is not available or not ready`);
          ctx.activity.record({
            session: sid,
            client,
            workspace,
            tool: activityTool,
            args: summarizeArgs(args),
            ok: false,
            summary: res.error || "Not available",
            ms: Date.now() - start,
            via: "exec",
          });
          return res;
        }

        if (!target.execAllowed) {
          const res = fail(
            activityTool,
            `Plugin tool '${activityTool}' is not allowed in exec (requires trusted plugin or read-only tool)`
          );
          ctx.activity.record({
            session: sid,
            client,
            workspace,
            tool: activityTool,
            args: summarizeArgs(args),
            ok: false,
            summary: res.error || "Not allowed",
            ms: Date.now() - start,
            via: "exec",
          });
          return res;
        }

        try {
          const callRes = await hub.callPluginTool(target.plugin, tool, args ?? {});
          const ok = !callRes.isError;
          const textParts: string[] = [];
          const images: Array<{ data: string; mimeType: string }> = [];

          if (Array.isArray(callRes.content)) {
            for (const part of callRes.content as any[]) {
              if (part && typeof part === "object") {
                if (part.type === "text" && typeof part.text === "string") {
                  textParts.push(part.text);
                } else if (
                  part.type === "image" &&
                  typeof part.data === "string" &&
                  typeof part.mimeType === "string"
                ) {
                  images.push({ data: part.data, mimeType: part.mimeType });
                }
              }
            }
          }

          const text = textParts.join("\n");
          const summary = text || (ok ? "OK" : "Plugin tool returned error");

          const res: ToolResult = {
            ok,
            tool: activityTool,
            summary,
            data: {
              text,
              structured: callRes.structuredContent,
            },
            error: ok ? undefined : (text || "Plugin tool returned error"),
            images: images.length > 0 ? images : undefined,
          };

          ctx.activity.record({
            session: sid,
            client,
            workspace,
            tool: activityTool,
            args: summarizeArgs(args),
            ok,
            summary: res.summary,
            ms: Date.now() - start,
            via: "exec",
          });

          return res;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const res = fail(activityTool, msg);
          ctx.activity.record({
            session: sid,
            client,
            workspace,
            tool: activityTool,
            args: summarizeArgs(args),
            ok: false,
            summary: msg,
            ms: Date.now() - start,
            via: "exec",
          });
          return res;
        }
      },
    };
  }

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
        const prevExtra = currentExtra;
        currentExtra = extra;
        const start = Date.now();
        let res: ToolResult;
        try {
          res = await tool.handler(args, ctx);
        } catch (err) {
          res = fail(tool.name, err);
        } finally {
          currentExtra = prevExtra;
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
          workspace: ctx.workspace.active(),
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
