/**
 * SHARED CONTRACT — owned by the orchestrator. Phase 3: plugins hub.
 *
 * The hub connects to external MCP servers ("plugins") and republishes their tools on a separate
 * endpoint `/mcp/plugins` (+ `/mcp/plugins/<MCP_TOKEN>`), so the core tool list stays small.
 * Implementation: src/plugins/hub.ts (agy1). Recipes: plugins/recipes.json + src/plugins/recipes.ts (agy2).
 * Persisted in DATA_DIR/plugins.json (file mode 0600: it holds secrets).
 */

export type PluginTransport =
  | {
      type: "stdio";
      /** Executable, no shell interpolation (e.g. "npx", "uvx", "node"). */
      command: string;
      args: string[];
      /** Extra env vars. Values may be secrets. */
      env?: Record<string, string>;
      cwd?: string;
    }
  | {
      type: "http";
      /** Streamable HTTP MCP URL: https://… or loopback http://. */
      url: string;
      /** Extra headers (e.g. Authorization). Values may be secrets. */
      headers?: Record<string, string>;
    };

export interface PluginConfig {
  /** Slug [a-z0-9-], unique, ≤ 40 chars. */
  id: string;
  name: string;
  enabled: boolean;
  transport: PluginTransport;
  /** Upstream tool names switched off by the user. */
  disabledTools: string[];
  /**
   * When true, this plugin's tools are annotated read-only (no approval prompts), like Trust mode.
   * Default false: upstream annotations are passed through and never made more permissive.
   */
  trusted: boolean;
  /** Recipe id it was created from, if any. */
  recipe?: string;
  createdAt: string;
}

/** What the admin API accepts. Omitted secret values (or the MASKED placeholder) keep the stored value. */
export interface PluginInput {
  id?: string;
  name: string;
  enabled?: boolean;
  transport: PluginTransport;
  trusted?: boolean;
  recipe?: string;
}

/** Placeholder the admin API returns instead of env/header values. */
export const MASKED = "••••••";

export type PluginState = "disabled" | "starting" | "ready" | "error";

export interface PluginStatus {
  state: PluginState;
  /** Short, actionable (first meaningful stderr line or connection error). */
  error?: string;
  /** Tools the upstream server declared. */
  toolCount: number;
  /** Tools actually published on /mcp/plugins (enabled, within limits, no name conflict). */
  publishedCount: number;
  startedAt?: string;
  /** Last ~40 stderr lines for stdio plugins (for the UI's log view). */
  stderrTail?: string[];
}

/** PluginConfig with secret values replaced by MASKED, plus live status. */
export interface PluginSummary extends PluginConfig {
  status: PluginStatus;
}

export interface PluginTool {
  plugin: string;
  /** Upstream name, unchanged. */
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  enabled: boolean;
  published: boolean;
  /** Why not published: "disabled" | "limit" | "conflict". */
  reason?: "disabled" | "limit" | "conflict";
}

export interface PluginDetail extends PluginSummary {
  tools: PluginTool[];
}

export interface PluginRecipeSecret {
  /** Env var name (stdio) or header name (http). */
  key: string;
  where: "env" | "header";
  label: string;
  required: boolean;
  help?: string;
  /** For headers like Authorization: value is `${prefix}${secret}`, e.g. "Bearer ". */
  prefix?: string;
}

export interface PluginRecipe {
  id: string;
  name: string;
  description: string;
  homepage: string;
  /** Transport with pinned package versions. */
  transport: PluginTransport;
  secrets: PluginRecipeSecret[];
  /** Runtime needed in the container: "node" | "uv" | "none". */
  runtime: "node" | "uv" | "none";
  notes?: string;
}

/** Publication limits across all enabled plugins. */
export const PLUGIN_LIMITS = Object.freeze({
  tools: 256,
  schemaBytes: 250 * 1024,
  /** Upstream declarations beyond this are refused as pathological. */
  maxDeclaredTools: 2048,
  startTimeoutMs: 60_000,
  callTimeoutMs: 120_000,
  maxResultBytes: 2 * 1024 * 1024,
});

export interface PluginHub {
  /** Load config and start every enabled plugin (does not throw on plugin failure). */
  start(): Promise<void>;
  stop(): Promise<void>;
  list(): PluginSummary[];
  get(id: string): PluginDetail | undefined;
  add(input: PluginInput): Promise<PluginSummary>;
  update(id: string, patch: Partial<PluginInput> & { enabled?: boolean }): Promise<PluginSummary>;
  remove(id: string): Promise<void>;
  restart(id: string): Promise<PluginSummary>;
  setToolEnabled(id: string, tool: string, enabled: boolean): Promise<PluginTool>;
  /** Tools to publish on /mcp/plugins right now (enabled + within PLUGIN_LIMITS, conflicts excluded). */
  publishedTools(): PluginTool[];
  /**
   * Forward a call to the owning plugin. Returns the upstream MCP CallToolResult unchanged
   * (content / structuredContent / isError). Never retries. Times out after callTimeoutMs.
   */
  callTool(name: string, args: Record<string, unknown>): Promise<{ content: unknown[]; structuredContent?: unknown; isError?: boolean }>;
  /** Fires when the published tool set or any status changes. */
  subscribe(fn: () => void): () => void;
}
