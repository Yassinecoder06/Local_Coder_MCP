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
  /**
   * Human-readable changes made to the upstream schema so strict clients (Gemini) accept it,
   * e.g. "limit: exclusiveMinimum 0 → minimum 0". Empty/absent = published unchanged.
   * `inputSchema` above is always the normalised schema (what clients see).
   */
  adjustments?: string[];
  /**
   * Callable from the main connector through `exec` (plugins.<id>.<tool>()).
   * Rule: tool enabled && plugin ready && (plugin.trusted || annotations.readOnlyHint === true).
   * Conflicts and the publication limit do not apply to exec (it addresses tools by plugin id).
   */
  execAllowed: boolean;
}

/**
 * Normalises a JSON Schema into the subset every client accepts (Gemini is the strictest).
 * Implemented in src/plugins/schema.ts as `normalizeToolSchema`. Pure, never throws.
 * Rules (each applied change adds one adjustment line "<path>: <what>"):
 *   - drop $schema, $id, $comment, examples, not, if/then/else, patternProperties,
 *     dependentRequired, dependentSchemas, unevaluatedProperties, contentMediaType, contentEncoding;
 *   - exclusiveMinimum/Maximum (number) → minimum/maximum + "(must be > n)" in description;
 *     boolean draft-4 form → dropped;
 *   - const v → enum [v]; non-string enum → dropped, "one of: …" appended to description;
 *   - type [T, "null"] → T; anyOf/oneOf with a {type:"null"} branch → that branch removed,
 *     single remaining branch inlined;
 *   - $ref to #/$defs|definitions inlined (depth ≤ 8; recursive → {type:"object"}), $defs removed;
 *   - allOf of objects merged (properties + required);
 *   - root forced to {type:"object", properties:{}} when missing; `required` entries not in
 *     properties removed;
 *   - kept as-is: type, properties, required, items, enum (strings), description, default,
 *     minimum, maximum, minItems, maxItems, minLength, maxLength, pattern, format,
 *     additionalProperties, propertyNames, anyOf (after the null rule), title, nullable.
 */
export type NormalizeToolSchema = (schema: unknown) => { schema: Record<string, unknown>; adjustments: string[] };

/**
 * "Paste anything" import. Implemented in src/plugins/import.ts as `parsePluginImport(text)`.
 * Accepts: a Claude/Cursor/VS Code style JSON config ({"mcpServers":{…}} or {"servers":{…}}),
 * a single server object ({command,args,env} or {url|serverUrl,headers}, `type` optional),
 * a shell command line ("npx -y pkg --flag 'quoted arg'", leading KEY=value env assignments allowed),
 * or a bare https:// / loopback http:// URL. Never runs anything.
 * Empty env/header values (or "<…>", "YOUR_…" placeholders) are reported in `needsSecrets`.
 */
export interface PluginImportResult {
  plugins: Array<PluginInput & { needsSecrets: { key: string; where: "env" | "header" }[] }>;
  warnings: string[];
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
  /** Every enabled tool of every ready plugin (normalised, with execAllowed). Used by the exec bridge. */
  execTools(): PluginTool[];
  /** Like callTool but addressed by plugin id (no conflict ambiguity). Throws if unknown/not ready. */
  callPluginTool(plugin: string, tool: string, args: Record<string, unknown>): Promise<{ content: unknown[]; structuredContent?: unknown; isError?: boolean }>;
  /** Fires when the published tool set or any status changes. */
  subscribe(fn: () => void): () => void;
}
