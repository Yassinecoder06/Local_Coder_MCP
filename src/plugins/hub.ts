/**
 * Owned by agy1. PluginHub implementation.
 * Connects to external MCP servers and manages their lifecycle, publication, and invocation.
 */
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AppConfig } from "../config.js";
import {
  type PluginConfig,
  type PluginDetail,
  type PluginHub,
  type PluginInput,
  type PluginStatus,
  type PluginSummary,
  type PluginTool,
  type PluginTransport,
  MASKED,
  PLUGIN_LIMITS,
} from "../core/plugins.js";

function validatePluginId(id: string): void {
  if (!id || typeof id !== "string") {
    throw new Error("Plugin ID is required");
  }
  if (id.length > 40) {
    throw new Error(`Plugin ID must be at most 40 characters (got ${id.length})`);
  }
  if (!/^[a-z0-9-]+$/.test(id)) {
    throw new Error(`Plugin ID must be a lowercase slug matching [a-z0-9-]: '${id}'`);
  }
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "plugin";
}

function validateTransport(transport: PluginTransport): void {
  if (!transport || typeof transport !== "object") {
    throw new Error("Missing transport definition");
  }
  if (transport.type === "stdio") {
    if (!transport.command || typeof transport.command !== "string" || !transport.command.trim()) {
      throw new Error("Stdio transport requires a non-empty command");
    }
    if (!Array.isArray(transport.args)) {
      throw new Error("Stdio transport requires an args array");
    }
  } else if (transport.type === "http") {
    if (!transport.url || typeof transport.url !== "string" || !transport.url.trim()) {
      throw new Error("HTTP transport requires a non-empty URL");
    }
    let parsed: URL;
    try {
      parsed = new URL(transport.url);
    } catch {
      throw new Error(`Invalid HTTP URL: ${transport.url}`);
    }
    if (parsed.protocol === "https:") {
      return;
    }
    if (parsed.protocol === "http:") {
      let hostname = parsed.hostname.toLowerCase();
      if (hostname.startsWith("[") && hostname.endsWith("]")) {
        hostname = hostname.slice(1, -1);
      }
      const isLoopback =
        hostname === "localhost" ||
        hostname === "127.0.0.1" ||
        hostname === "::1" ||
        hostname === "0.0.0.0";
      if (isLoopback) {
        return;
      }
      throw new Error(`Insecure HTTP URL not allowed: ${transport.url}. Only HTTPS or loopback HTTP allowed.`);
    }
    throw new Error(`Unsupported protocol '${parsed.protocol}'. Only HTTPS or loopback HTTP allowed.`);
  } else {
    throw new Error(`Unknown transport type: ${(transport as any)?.type}`);
  }
}

function maskTransport(t: PluginTransport): PluginTransport {
  if (t.type === "stdio") {
    const maskedEnv: Record<string, string> | undefined = t.env
      ? Object.fromEntries(Object.keys(t.env).map((k) => [k, MASKED]))
      : undefined;
    return {
      type: "stdio",
      command: t.command,
      args: [...t.args],
      cwd: t.cwd,
      env: maskedEnv,
    };
  } else {
    const maskedHeaders: Record<string, string> | undefined = t.headers
      ? Object.fromEntries(Object.keys(t.headers).map((k) => [k, MASKED]))
      : undefined;
    return {
      type: "http",
      url: t.url,
      headers: maskedHeaders,
    };
  }
}

function mergeTransportSecrets(existing: PluginTransport, incoming: PluginTransport): PluginTransport {
  if (incoming.type === "stdio") {
    let finalEnv: Record<string, string> | undefined = incoming.env ? { ...incoming.env } : undefined;
    if (existing.type === "stdio" && existing.env && finalEnv) {
      for (const [k, v] of Object.entries(finalEnv)) {
        if (v === MASKED && existing.env[k] !== undefined) {
          finalEnv[k] = existing.env[k];
        }
      }
    }
    return {
      type: "stdio",
      command: incoming.command,
      args: [...incoming.args],
      cwd: incoming.cwd,
      env: finalEnv,
    };
  } else {
    let finalHeaders: Record<string, string> | undefined = incoming.headers ? { ...incoming.headers } : undefined;
    if (existing.type === "http" && existing.headers && finalHeaders) {
      for (const [k, v] of Object.entries(finalHeaders)) {
        if (v === MASKED && existing.headers[k] !== undefined) {
          finalHeaders[k] = existing.headers[k];
        }
      }
    }
    return {
      type: "http",
      url: incoming.url,
      headers: finalHeaders,
    };
  }
}

interface UpstreamDeclaredTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}


/** Env passed through to stdio plugins on top of the SDK's minimal default env. */
const PASSTHROUGH_ENV = ["npm_config_cache", "UV_CACHE_DIR", "UV_TOOL_DIR", "UV_PYTHON_INSTALL_DIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "CHROMIUM_PATH", "TZ", "LANG", "NODE_EXTRA_CA_CERTS"];

/**
 * Stdio plugins run npx/uvx, which need writable caches and HOME. In Docker with the host-tools
 * override HOME is the host home (not writable), so fall back to DATA_DIR/cache.
 */
export function pluginBaseEnv(dataDir: string, env: NodeJS.ProcessEnv = process.env, canWrite: (dir: string) => boolean = writable): Record<string, string> {
  const out: Record<string, string> = { ...getDefaultEnvironment() };
  for (const k of PASSTHROUGH_ENV) if (env[k]) out[k] = env[k] as string;
  const cache = path.join(dataDir, "cache");
  if (!out.HOME || !canWrite(out.HOME)) out.HOME = path.join(cache, "home");
  if (!out.XDG_CACHE_HOME || !canWrite(out.XDG_CACHE_HOME)) out.XDG_CACHE_HOME = path.join(cache, "xdg");
  if (!out.XDG_CONFIG_HOME || !canWrite(out.XDG_CONFIG_HOME)) out.XDG_CONFIG_HOME = path.join(out.HOME, ".config");
  out.npm_config_cache ??= path.join(cache, "npm");
  out.UV_CACHE_DIR ??= path.join(cache, "uv");
  out.UV_TOOL_DIR ??= path.join(cache, "uv-tools");
  out.UV_PYTHON_INSTALL_DIR ??= path.join(cache, "uv-python");
  for (const k of ["HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "npm_config_cache", "UV_CACHE_DIR", "UV_TOOL_DIR", "UV_PYTHON_INSTALL_DIR"]) {
    try {
      fsSync.mkdirSync(out[k], { recursive: true });
    } catch {
      /* reported by the plugin itself if it matters */
    }
  }
  return out;
}

function writable(dir: string): boolean {
  try {
    fsSync.accessSync(dir, fsSync.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

let pluginDataDir = path.resolve("data");

class PluginInstance {
  public status: PluginStatus = {
    state: "disabled",
    toolCount: 0,
    publishedCount: 0,
    stderrTail: [],
  };
  public declaredTools: UpstreamDeclaredTool[] = [];
  private client: Client | null = null;
  private transport: StdioClientTransport | StreamableHTTPClientTransport | null = null;
  private stopping = false;

  constructor(
    public config: PluginConfig,
    private onChange: () => void
  ) {
    if (!config.enabled) {
      this.status.state = "disabled";
    }
  }

  public getSummary(): PluginSummary {
    return {
      ...this.config,
      transport: maskTransport(this.config.transport),
      status: {
        ...this.status,
        stderrTail: this.status.stderrTail ? [...this.status.stderrTail] : undefined,
      },
    };
  }

  public appendStderr(line: string): void {
    if (!this.status.stderrTail) this.status.stderrTail = [];
    this.status.stderrTail.push(line);
    if (this.status.stderrTail.length > 40) {
      this.status.stderrTail.shift();
    }
  }

  public async start(): Promise<void> {
    if (!this.config.enabled) {
      this.status.state = "disabled";
      this.status.error = undefined;
      return;
    }

    await this.stop();
    this.stopping = false;
    this.status.state = "starting";
    this.status.error = undefined;
    this.status.startedAt = new Date().toISOString();
    this.status.stderrTail = [];
    this.onChange();

    try {
      const client = new Client(
        { name: "local-coder-hub", version: "1.0.0" },
        { capabilities: {} }
      );

      let transport: StdioClientTransport | StreamableHTTPClientTransport;

      if (this.config.transport.type === "stdio") {
        const stdioEnv = {
          ...pluginBaseEnv(pluginDataDir),
          ...(this.config.transport.env ?? {}),
        };

        const stdioTransport = new StdioClientTransport({
          command: this.config.transport.command,
          args: this.config.transport.args,
          env: stdioEnv,
          cwd: this.config.transport.cwd,
          stderr: "pipe",
        });

        // Hook up stderr streaming immediately to capture early crash output
        stdioTransport.stderr?.on("data", (chunk: Buffer | string) => {
          const lines = chunk.toString("utf-8").split(/\r?\n/);
          for (const line of lines) {
            if (line.trim().length > 0) {
              this.appendStderr(line);
            }
          }
        });

        transport = stdioTransport;
      } else {
        transport = new StreamableHTTPClientTransport(new URL(this.config.transport.url), {
          requestInit: {
            headers: this.config.transport.headers,
          },
        });
      }

      this.client = client;
      this.transport = transport;

      // Handle unexpected transport closure or process crash
      transport.onclose = () => {
        if (this.stopping) return;
        this.status.state = "error";
        const tail = this.status.stderrTail || [];
        const lastErrorLine = [...tail].reverse().find((l) => l.trim().length > 0);
        this.status.error = lastErrorLine?.trim() || this.status.error || "Plugin process closed unexpectedly";
        this.declaredTools = [];
        this.status.toolCount = 0;
        this.status.publishedCount = 0;
        this.onChange();
      };

      transport.onerror = (err) => {
        if (this.stopping) return;
        this.status.state = "error";
        const tail = this.status.stderrTail || [];
        const lastErrorLine = [...tail].reverse().find((l) => l.trim().length > 0);
        this.status.error = lastErrorLine?.trim() || err.message || String(err);
        this.onChange();
      };

      // Connect with timeout
      await withTimeout(
        client.connect(transport),
        PLUGIN_LIMITS.startTimeoutMs,
        `Plugin connection timed out after ${PLUGIN_LIMITS.startTimeoutMs}ms`
      );

      // Query declared tools
      const listRes = await withTimeout(
        client.listTools(),
        PLUGIN_LIMITS.startTimeoutMs,
        "Plugin listTools timed out"
      );

      const tools = listRes.tools || [];
      if (tools.length > PLUGIN_LIMITS.maxDeclaredTools) {
        throw new Error(`Plugin declared ${tools.length} tools, exceeding maximum allowed (${PLUGIN_LIMITS.maxDeclaredTools})`);
      }

      this.declaredTools = tools.map((t) => ({
        name: t.name,
        description: t.description || "",
        inputSchema: (t.inputSchema as Record<string, unknown>) || {},
        annotations: (t.annotations as Record<string, unknown>) || undefined,
      }));

      this.status.state = "ready";
      this.status.error = undefined;
      this.status.toolCount = this.declaredTools.length;
      this.onChange();
    } catch (err) {
      if ((!this.status.stderrTail || this.status.stderrTail.length === 0) && this.config.transport.type === "stdio") {
        await new Promise((r) => {
          const t = setTimeout(r, 50);
          t.unref?.();
        });
      }
      this.status.state = "error";
      const tail = this.status.stderrTail || [];
      const lastErrorLine = [...tail].reverse().find((l) => l.trim().length > 0);
      this.status.error = lastErrorLine?.trim() || (err instanceof Error ? err.message : String(err));
      this.declaredTools = [];
      this.status.toolCount = 0;
      this.status.publishedCount = 0;
      this.onChange();
      await this.stop();
    }
  }

  public async stop(): Promise<void> {
    this.stopping = true;
    const client = this.client;
    const transport = this.transport;
    this.client = null;
    this.transport = null;

    try {
      if (client) {
        await client.close();
      }
    } catch {}
    try {
      if (transport) {
        await transport.close();
      }
    } catch {}

    if (transport && "pid" in transport && typeof (transport as any).pid === "number") {
      try {
        process.kill((transport as any).pid, "SIGTERM");
      } catch {}
    }
  }

  public async callTool(name: string, args: Record<string, unknown>): Promise<{ content: unknown[]; structuredContent?: unknown; isError?: boolean }> {
    if (!this.client || this.status.state !== "ready") {
      throw new Error(`Plugin '${this.config.id}' is not ready (state: ${this.status.state})`);
    }

    const res = await withTimeout(
      this.client.callTool({ name, arguments: args }),
      PLUGIN_LIMITS.callTimeoutMs,
      `Tool call timed out after ${PLUGIN_LIMITS.callTimeoutMs}ms`
    );

    const result = {
      content: (res.content as unknown[]) ?? [],
      structuredContent: res.structuredContent,
      isError: res.isError as boolean | undefined,
    };

    const serialized = JSON.stringify(result);
    if (Buffer.byteLength(serialized, "utf-8") > PLUGIN_LIMITS.maxResultBytes) {
      throw new Error(`Plugin tool result exceeded size limit of ${PLUGIN_LIMITS.maxResultBytes} bytes`);
    }

    return result;
  }
}

export function createPluginHub(config: AppConfig): PluginHub {
  pluginDataDir = config.dataDir;
  const configFile = path.join(config.dataDir, "plugins.json");
  const instances = new Map<string, PluginInstance>();
  const listeners = new Set<() => void>();
  let publishedCache: PluginTool[] = [];
  let saveChain: Promise<void> = Promise.resolve();

  function emitChange(): void {
    computePublication();
    for (const fn of listeners) {
      try {
        fn();
      } catch {}
    }
  }

  function computePublication(): void {
    const readyInstances = Array.from(instances.values()).filter((inst) => inst.status.state === "ready");

    // 1. Detect duplicate names across plugins
    const nameToPlugins = new Map<string, string[]>();
    for (const inst of readyInstances) {
      for (const t of inst.declaredTools) {
        const list = nameToPlugins.get(t.name) || [];
        list.push(inst.config.id);
        nameToPlugins.set(t.name, list);
      }
    }

    let publishedCount = 0;
    let totalSchemaBytes = 0;
    const nextPublished: PluginTool[] = [];

    for (const inst of readyInstances) {
      let instPublishedCount = 0;
      for (const t of inst.declaredTools) {
        const conflicts = nameToPlugins.get(t.name) || [];
        const isConflict = conflicts.length > 1;
        const isDisabled = inst.config.disabledTools.includes(t.name);

        const schemaBytes = Buffer.byteLength(JSON.stringify(t.inputSchema || {}), "utf-8");
        const exceedsLimits =
          publishedCount + 1 > PLUGIN_LIMITS.tools ||
          totalSchemaBytes + schemaBytes > PLUGIN_LIMITS.schemaBytes;

        let published = false;
        let reason: "disabled" | "limit" | "conflict" | undefined;

        if (isConflict) {
          published = false;
          reason = "conflict";
        } else if (isDisabled) {
          published = false;
          reason = "disabled";
        } else if (exceedsLimits) {
          published = false;
          reason = "limit";
        } else {
          published = true;
          reason = undefined;
          publishedCount++;
          totalSchemaBytes += schemaBytes;
          instPublishedCount++;

          const annotations = inst.config.trusted
            ? { ...(t.annotations || {}), readOnlyHint: true }
            : t.annotations;

          nextPublished.push({
            plugin: inst.config.id,
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
            annotations,
            enabled: true,
            published: true,
          });
        }
      }
      inst.status.publishedCount = instPublishedCount;
    }

    publishedCache = nextPublished;
  }

  async function persist(configs: PluginConfig[]): Promise<void> {
    saveChain = saveChain.then(async () => {
      await fs.mkdir(config.dataDir, { recursive: true });
      const tmp = `${configFile}.${process.pid}.${Date.now()}.tmp`;
      const json = JSON.stringify({ plugins: configs }, null, 2);
      await fs.writeFile(tmp, json, { encoding: "utf-8", mode: 0o600 });
      await fs.rename(tmp, configFile);
    });
    await saveChain;
  }

  async function loadConfigs(): Promise<PluginConfig[]> {
    try {
      const content = await fs.readFile(configFile, "utf-8");
      const parsed = JSON.parse(content);
      const list = Array.isArray(parsed?.plugins) ? parsed.plugins : [];
      return list;
    } catch {
      return [];
    }
  }

  return {
    async start(): Promise<void> {
      const configs = await loadConfigs();
      for (const cfg of configs) {
        const inst = new PluginInstance(cfg, () => emitChange());
        instances.set(cfg.id, inst);
      }
      // Start all enabled plugins concurrently; catch errors so startup never aborts
      await Promise.all(Array.from(instances.values()).map((inst) => inst.start()));
      computePublication();
    },

    async stop(): Promise<void> {
      await Promise.all(Array.from(instances.values()).map((inst) => inst.stop()));
      instances.clear();
      publishedCache = [];
    },

    list(): PluginSummary[] {
      return Array.from(instances.values()).map((inst) => inst.getSummary());
    },

    get(id: string): PluginDetail | undefined {
      const inst = instances.get(id);
      if (!inst) return undefined;

      computePublication();

      const conflicts = new Map<string, number>();
      for (const other of instances.values()) {
        if (other.status.state === "ready") {
          for (const t of other.declaredTools) {
            conflicts.set(t.name, (conflicts.get(t.name) || 0) + 1);
          }
        }
      }

      const tools: PluginTool[] = inst.declaredTools.map((t) => {
        const hasConflict = (conflicts.get(t.name) || 0) > 1;
        const isDisabled = inst.config.disabledTools.includes(t.name);
        const isPublished = publishedCache.some((pt) => pt.plugin === id && pt.name === t.name);

        let reason: "disabled" | "limit" | "conflict" | undefined;
        if (hasConflict) reason = "conflict";
        else if (isDisabled) reason = "disabled";
        else if (!isPublished && inst.status.state === "ready") reason = "limit";

        const annotations = inst.config.trusted
          ? { ...(t.annotations || {}), readOnlyHint: true }
          : t.annotations;

        return {
          plugin: id,
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations,
          enabled: !isDisabled,
          published: isPublished,
          reason,
        };
      });

      return {
        ...inst.getSummary(),
        tools,
      };
    },

    async add(input: PluginInput): Promise<PluginSummary> {
      if (!input || typeof input !== "object") {
        throw new Error("Missing plugin input body");
      }
      if (!input.name || typeof input.name !== "string" || !input.name.trim()) {
        throw new Error("Plugin name is required");
      }

      let id = input.id ? String(input.id).trim() : slugify(input.name);
      validatePluginId(id);
      if (instances.has(id)) {
        throw new Error(`Plugin with ID '${id}' already exists`);
      }

      validateTransport(input.transport);

      const newConfig: PluginConfig = {
        id,
        name: input.name.trim(),
        enabled: input.enabled ?? true,
        transport: input.transport,
        disabledTools: [],
        trusted: input.trusted ?? false,
        recipe: input.recipe,
        createdAt: new Date().toISOString(),
      };

      const inst = new PluginInstance(newConfig, () => emitChange());
      instances.set(id, inst);

      const allConfigs = Array.from(instances.values()).map((i) => i.config);
      await persist(allConfigs);

      if (newConfig.enabled) {
        await inst.start();
      }

      emitChange();
      return inst.getSummary();
    },

    async update(id: string, patch: Partial<PluginInput> & { enabled?: boolean }): Promise<PluginSummary> {
      const inst = instances.get(id);
      if (!inst) {
        throw new Error(`Plugin not found: ${id}`);
      }

      if (patch.name !== undefined) {
        if (!patch.name || typeof patch.name !== "string" || !patch.name.trim()) {
          throw new Error("Plugin name cannot be empty");
        }
        inst.config.name = patch.name.trim();
      }

      if (patch.trusted !== undefined) {
        inst.config.trusted = Boolean(patch.trusted);
      }

      if (patch.recipe !== undefined) {
        inst.config.recipe = patch.recipe;
      }

      let transportChanged = false;
      if (patch.transport !== undefined) {
        validateTransport(patch.transport);
        inst.config.transport = mergeTransportSecrets(inst.config.transport, patch.transport);
        transportChanged = true;
      }

      let enabledChanged = false;
      if (patch.enabled !== undefined && patch.enabled !== inst.config.enabled) {
        inst.config.enabled = Boolean(patch.enabled);
        enabledChanged = true;
      }

      const allConfigs = Array.from(instances.values()).map((i) => i.config);
      await persist(allConfigs);

      if (enabledChanged || transportChanged) {
        if (inst.config.enabled) {
          await inst.start();
        } else {
          await inst.stop();
          inst.status.state = "disabled";
          inst.status.error = undefined;
          inst.declaredTools = [];
          inst.status.toolCount = 0;
          inst.status.publishedCount = 0;
        }
      }

      emitChange();
      return inst.getSummary();
    },

    async remove(id: string): Promise<void> {
      const inst = instances.get(id);
      if (!inst) {
        throw new Error(`Plugin not found: ${id}`);
      }
      await inst.stop();
      instances.delete(id);

      const allConfigs = Array.from(instances.values()).map((i) => i.config);
      await persist(allConfigs);
      emitChange();
    },

    async restart(id: string): Promise<PluginSummary> {
      const inst = instances.get(id);
      if (!inst) {
        throw new Error(`Plugin not found: ${id}`);
      }
      if (inst.config.enabled) {
        await inst.start();
      }
      emitChange();
      return inst.getSummary();
    },

    async setToolEnabled(id: string, tool: string, enabled: boolean): Promise<PluginTool> {
      const inst = instances.get(id);
      if (!inst) {
        throw new Error(`Plugin not found: ${id}`);
      }

      if (enabled) {
        inst.config.disabledTools = inst.config.disabledTools.filter((t) => t !== tool);
      } else {
        if (!inst.config.disabledTools.includes(tool)) {
          inst.config.disabledTools.push(tool);
        }
      }

      const allConfigs = Array.from(instances.values()).map((i) => i.config);
      await persist(allConfigs);
      emitChange();

      const detail = this.get(id);
      const toolDetail = detail?.tools.find((t) => t.name === tool);
      if (toolDetail) return toolDetail;

      return {
        plugin: id,
        name: tool,
        description: "",
        inputSchema: {},
        enabled,
        published: enabled && publishedCache.some((pt) => pt.plugin === id && pt.name === tool),
      };
    },

    publishedTools(): PluginTool[] {
      computePublication();
      return publishedCache;
    },

    async callTool(name: string, args: Record<string, unknown>): Promise<{ content: unknown[]; structuredContent?: unknown; isError?: boolean }> {
      computePublication();
      const pubTool = publishedCache.find((t) => t.name === name);
      if (!pubTool) {
        throw new Error(`Plugin tool '${name}' is not published or does not exist`);
      }

      const inst = instances.get(pubTool.plugin);
      if (!inst) {
        throw new Error(`Plugin '${pubTool.plugin}' not found`);
      }

      return await inst.callTool(name, args);
    },

    subscribe(fn: () => void): () => void {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
