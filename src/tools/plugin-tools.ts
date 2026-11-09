import { z } from "zod";
import { defineTool, type ToolModule } from "../core/types.js";
import { fail } from "../core/result.js";

function firstSentence(desc?: string): string {
  if (!desc) return "";
  const trimmed = desc.trim();
  const match = trimmed.match(/^([^.\n]+(?:\.|\n|$))/);
  return match ? match[1].trim() : trimmed;
}

function formatPluginName(id: string): string {
  return id
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export const pluginToolsTool = defineTool({
  name: "plugin_tools",
  title: "Plugin Tools",
  description:
    "Inspect external MCP plugins and their tools. Call with no arguments to list ready plugins and tool summaries. Call with plugin and tools to retrieve full input schemas.",
  group: "system",
  risk: "read",
  input: {
    plugin: z.string().optional().describe("Plugin ID to inspect tools for"),
    tools: z
      .array(z.string())
      .max(20)
      .optional()
      .describe("Tool names to inspect full input schemas for (max 20)"),
  },
  handler: async (args, ctx) => {
    if (!ctx.plugins) {
      return {
        ok: true,
        tool: "plugin_tools",
        summary: "No plugins are configured. Add one in Admin → Plugins.",
        data: {
          plugins: [],
          hint: "No plugins are configured. Add one in Admin → Plugins.",
        },
      };
    }

    const allTools = ctx.plugins.list();
    if (!allTools || allTools.length === 0) {
      return {
        ok: true,
        tool: "plugin_tools",
        summary: "No plugins are configured. Add one in Admin → Plugins.",
        data: {
          plugins: [],
          hint: "No plugins are configured. Add one in Admin → Plugins.",
        },
      };
    }

    // If specific tools requested
    if (args.tools && args.tools.length > 0) {
      const requestedTools = new Set(args.tools);
      let targetTools = allTools;
      if (args.plugin) {
        const targetPlugin = args.plugin.toLowerCase();
        const hyphens = targetPlugin.replace(/_/g, "-");
        const underscores = targetPlugin.replace(/-/g, "_");
        targetTools = allTools.filter(
          (t) => t.plugin === targetPlugin || t.plugin === hyphens || t.plugin === underscores
        );
        if (targetTools.length === 0) {
          return fail(
            "plugin_tools",
            `Plugin '${args.plugin}' not found. Call plugin_tools with no arguments to list available plugins.`
          );
        }
      }

      const matching = targetTools.filter((t) => requestedTools.has(t.name));
      const schemas = matching.map((t) => ({
        plugin: t.plugin,
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        execAllowed: t.execAllowed,
      }));

      const summary = `Retrieved schemas for ${schemas.length} tool${schemas.length === 1 ? "" : "s"}${
        args.plugin ? ` from plugin '${args.plugin}'` : ""
      }`;

      return {
        ok: true,
        tool: "plugin_tools",
        summary,
        data: {
          tools: schemas,
        },
      };
    }

    // If only plugin was requested (without tools list)
    if (args.plugin && (!args.tools || args.tools.length === 0)) {
      const targetPlugin = args.plugin.toLowerCase();
      const hyphens = targetPlugin.replace(/_/g, "-");
      const underscores = targetPlugin.replace(/-/g, "_");
      const targetTools = allTools.filter(
        (t) => t.plugin === targetPlugin || t.plugin === hyphens || t.plugin === underscores
      );
      if (targetTools.length === 0) {
        return fail(
          "plugin_tools",
          `Plugin '${args.plugin}' not found. Call plugin_tools with no arguments to list available plugins.`
        );
      }
      const schemas = targetTools.slice(0, 20).map((t) => ({
        plugin: t.plugin,
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        execAllowed: t.execAllowed,
      }));
      return {
        ok: true,
        tool: "plugin_tools",
        summary: `Retrieved schemas for ${schemas.length} tool${schemas.length === 1 ? "" : "s"} from plugin '${args.plugin}'`,
        data: {
          tools: schemas,
        },
      };
    }

    // No args: list ready plugins
    const pluginsMap = new Map<string, typeof allTools>();
    for (const t of allTools) {
      const list = pluginsMap.get(t.plugin) || [];
      list.push(t);
      pluginsMap.set(t.plugin, list);
    }

    const pluginSummaries = Array.from(pluginsMap.entries()).map(([pluginId, tools]) => {
      const allowedCount = tools.filter((t) => t.execAllowed).length;
      const toolSummaries = tools.map((t) => {
        const sentence = firstSentence(t.description);
        const blocked = t.execAllowed ? "" : " [blocked: not read-only; mark plugin Trusted to allow]";
        return sentence ? `${t.name} — ${sentence}${blocked}` : `${t.name}${blocked}`;
      });

      const firstTool = tools[0] as any;
      const pluginName = firstTool?.pluginName || formatPluginName(pluginId);

      return {
        id: pluginId,
        name: pluginName,
        toolCount: tools.length,
        tool_count: tools.length,
        execAllowedCount: allowedCount,
        exec_allowed_count: allowedCount,
        tools: toolSummaries,
      };
    });

    const totalPlugins = pluginSummaries.length;
    const totalTools = allTools.length;
    const summary = `${totalPlugins} ready plugin${totalPlugins === 1 ? "" : "s"} with ${totalTools} tool${
      totalTools === 1 ? "" : "s"
    }`;

    return {
      ok: true,
      tool: "plugin_tools",
      summary,
      data: {
        plugins: pluginSummaries,
      },
    };
  },
});

const tools: ToolModule = [pluginToolsTool];
export default tools;
