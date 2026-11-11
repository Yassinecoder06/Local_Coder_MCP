/**
 * SHARED CONTRACT — owned by the orchestrator. Do not change signatures without
 * coordinating; every tool module, the MCP server and the admin API depend on it.
 */
import type { Board } from "./board.js";
import type { z } from "zod";
import type { AppConfig } from "../config.js";
import type { SkillRegistry } from "../skills/registry.js";
import type { CommandRegistry } from "../commands/registry.js";
import type { ActivityLog } from "./activity.js";
import type { Workspace } from "./workspace.js";

/**
 * Risk drives MCP tool annotations (see core/annotations.ts):
 *  - read:   never changes anything  -> readOnlyHint: true (no confirmation in ChatGPT/Gemini)
 *  - write:  edits files in the workspace
 *  - exec:   runs commands
 */
export type ToolRisk = "read" | "write" | "exec";

export interface TruncationRecord {
  path: string;
  keptBytes: number;
  omittedBytes: number;
}

/** Stable result envelope returned (as structuredContent + short text) by every tool. */
export interface ToolResult<T = unknown> {
  ok: boolean;
  tool: string;
  summary: string;
  data?: T;
  error?: string;
  truncated?: boolean;
  truncation?: TruncationRecord[];
  /** Optional images (e.g. browser screenshots) sent as MCP image content; never put in text/structuredContent. */
  images?: { data: string; mimeType: string }[];
}

/** Everything a tool handler may use. Built once per MCP session. */
export interface ToolContext {
  /** Optional per-call deadline supplied by clients with short tool-call budgets. */
  callBudgetMs?: number;
  /** Normalized MCP client kind used for client-specific policy and diagnostics. */
  clientKind?: string;
  config: AppConfig;
  workspace: Workspace;
  skills: SkillRegistry;
  commands: CommandRegistry;
  activity: ActivityLog;
  /** Requests to the person, finish reports and plan events (src/core/board.ts). Wired per session by src/http/session-manager.ts. */
  board?: Board;
  /**
   * Call another registered tool by name (used by `exec`). Provided by src/mcp/server.ts:
   * same enabled/profile filtering, arg validation, error wrapping and activity logging
   * (with via: "exec") as a direct call. Never exposes `exec` itself (no recursion).
   * Undefined in contexts that are not an MCP session (e.g. some tests).
   */
  callTool?: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
  /** Names callable through callTool (enabled, not `exec`). */
  callableTools?: () => { name: string; description: string }[];
  /**
   * Plugin tools reachable from the main connector (via `exec` and `plugin_tools`). Wired by
   * src/mcp/server.ts from the PluginHub. Undefined when there is no hub. See src/core/plugins.ts.
   */
  plugins?: PluginBridge;
}

/** Contract (orchestrator): how core tools reach plugin tools without a second connector. */
export interface PluginBridge {
  /** Ready plugins and their enabled tools (normalised schemas), with execAllowed per tool. */
  list(): import("./plugins.js").PluginTool[];
  /**
   * Calls `tool` on plugin `plugin` (id; "_" also accepted for "-"). Refuses (ok:false, never throws)
   * when the plugin is not ready, the tool is disabled/unknown, or execAllowed is false.
   * Converts the upstream CallToolResult: text parts joined into `summary`/`data.text`, image parts into
   * `images`, structuredContent into `data.structured`, isError into ok:false. Logs activity
   * with tool "<plugin>.<tool>" and via:"exec".
   */
  call(plugin: string, tool: string, args: Record<string, unknown>): Promise<ToolResult>;
}

export interface ToolDefinition<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string; // snake_case, unique
  title: string; // short human label shown in ChatGPT/Gemini
  description: string; // 1-3 sentences, written for the model
  group: ToolGroup;
  risk: ToolRisk;
  input: S; // zod raw shape
  handler: (args: z.infer<z.ZodObject<S>>, ctx: ToolContext) => Promise<ToolResult>;
}

export type ToolGroup = "files" | "search" | "shell" | "git" | "workspace" | "skills" | "commands" | "system";

/** Every module in src/tools/*.ts default-exports a ToolModule. */
export type ToolModule = ToolDefinition<any>[];

/** Helper so modules get type inference: `export default [defineTool({...}), ...]`. */
export function defineTool<S extends z.ZodRawShape>(def: ToolDefinition<S>): ToolDefinition<S> {
  return def;
}
