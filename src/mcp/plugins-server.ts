/**
 * Owned by agy1. Creates and configures McpServer instances for the /mcp/plugins endpoint.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { AppConfig } from "../config.js";
import type { ActivityLog } from "../core/activity.js";
import type { PluginHub } from "../core/plugins.js";

function inferClient(clientName?: string, headers?: { userAgent?: string; origin?: string }): string {
  if (clientName && clientName.trim() && clientName !== "unknown") {
    return clientName.trim();
  }
  const ua = headers?.userAgent || "";
  const origin = headers?.origin || "";
  const combined = `${ua} ${origin}`.toLowerCase();
  if (combined.includes("chatgpt") || combined.includes("openai")) return "chatgpt";
  if (combined.includes("gemini") || combined.includes("google")) return "gemini";
  return "unknown";
}

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

export function buildPluginsInstructions(hub: PluginHub): string {
  const plugins = hub.list().filter((p) => p.enabled);
  if (plugins.length === 0) {
    return "Plugins hub for Local Coder MCP. No external plugins are currently enabled.";
  }
  const names = plugins.map((p) => p.name).join(", ");
  return `Plugins hub for Local Coder MCP: republishes tools from external plugins (${names}).`;
}

export async function createPluginsMcpServer(
  config: AppConfig,
  hub: PluginHub,
  activity: ActivityLog,
  sessionId: string,
  getHeaders?: () => { userAgent?: string; origin?: string } | undefined
): Promise<Server> {
  const server = new Server(
    { name: "local-coder-plugins", version: config.version },
    {
      capabilities: {
        tools: { listChanged: true },
      },
      instructions: buildPluginsInstructions(hub),
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const published = hub.publishedTools();
    return {
      tools: published.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        annotations: t.annotations,
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;
    const start = Date.now();
    const headers = (extra as any)?.requestInfo?.headers ?? getHeaders?.();
    const client = inferClient(server.getClientVersion()?.name, headers);
    const sid = (sessionId || "").slice(0, 8) || undefined;

    const tool = hub.publishedTools().find((t) => t.name === name);
    const pluginId = tool?.plugin ?? "unknown";
    const activityTool = `${pluginId}/${name}`;

    try {
      const res = await hub.callTool(name, (args as Record<string, unknown>) ?? {});
      const ms = Date.now() - start;
      const ok = !res.isError;
      activity.record({
        session: sid,
        client,
        workspace: "",
        tool: activityTool,
        args: summarizeArgs(args),
        ok,
        summary: ok ? "OK" : "Plugin tool returned error",
        ms,
      });
      return res;
    } catch (err) {
      const ms = Date.now() - start;
      const msg = err instanceof Error ? err.message : String(err);
      activity.record({
        session: sid,
        client,
        workspace: "",
        tool: activityTool,
        args: summarizeArgs(args),
        ok: false,
        summary: msg,
        ms,
      });
      return {
        content: [{ type: "text", text: `Error calling plugin tool ${name}: ${msg}` }],
        isError: true,
      };
    }
  });

  return server;
}
