/**
 * Owned by agy2. Paste-anything import parser for plugins.
 *
 * Implements parsePluginImport(text) per the contract in src/core/plugins.ts:
 * Accepts:
 *   - Claude / Cursor / generic JSON: {"mcpServers": { ... }}
 *   - VS Code JSON: {"servers": { ... }} (type "sse" -> warning, treated as "http")
 *   - Single server object: { command, args, env } or { url|serverUrl, headers }
 *   - Shell command lines: "npx -y @scope/pkg@1.2.3 --flag 'quoted arg'" (leading KEY=val env allowed)
 *   - Docker command lines: "docker run -i --rm image" (allowed, warns about docker socket)
 *   - Bare URLs: https://... or loopback http://...
 * Never executes anything. Pure, never throws.
 */

import type { PluginImportResult, PluginInput, PluginTransport } from "../core/plugins.js";

/** Strips JavaScript/JSON comments and trailing commas before object/array close. */
export function stripJsonCommentsAndTrailingCommas(raw: string): string {
  let inString = false;
  let stringChar = "";
  let inLineComment = false;
  let inBlockComment = false;
  let isEscaped = false;
  const out: string[] = [];

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    const next = i + 1 < raw.length ? raw[i + 1] : "";

    if (inLineComment) {
      if (ch === "\n" || ch === "\r") {
        inLineComment = false;
        out.push(ch);
      }
      continue;
    }

    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i++; // skip /
      }
      continue;
    }

    if (inString) {
      out.push(ch);
      if (isEscaped) {
        isEscaped = false;
      } else if (ch === "\\") {
        isEscaped = true;
      } else if (ch === stringChar) {
        inString = false;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
      out.push(ch);
      continue;
    }

    if (ch === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }

    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }

    // Trailing comma check
    if (ch === ",") {
      let j = i + 1;
      while (j < raw.length && /\s/.test(raw[j])) {
        j++;
      }
      if (j < raw.length && (raw[j] === "}" || raw[j] === "]")) {
        continue;
      }
    }

    out.push(ch);
  }

  return out.join("");
}

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "plugin";
}

function formatDisplayName(str: string): string {
  const words = str
    .replace(/[@/_-]+/g, " ")
    .trim()
    .split(/\s+/);
  return words
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

export function deriveNameFromPackage(pkg: string): { name: string; id: string } {
  let cleaned = pkg.trim();
  const atIdx = cleaned.lastIndexOf("@");
  if (atIdx > 0) {
    cleaned = cleaned.slice(0, atIdx);
  }

  let base = cleaned;
  if (base.startsWith("@")) {
    const parts = base.slice(1).split("/");
    const scope = parts[0] || "";
    const namePart = parts[1] || "";

    if (namePart === "mcp" || namePart === "server" || namePart === "mcp-server") {
      base = scope;
    } else if (scope === "modelcontextprotocol" || scope === "model-context-protocol") {
      base = namePart.replace(/^(mcp-)?server-/, "");
    } else {
      base = namePart || scope;
    }
  } else {
    // Non-scoped package or image like mcp/fetch
    if (base.startsWith("mcp/")) {
      base = base.slice(4);
    } else if (base.includes("/")) {
      const parts = base.split("/");
      base = parts[parts.length - 1] || base;
    }
    base = base.replace(/^mcp-server-/, "").replace(/-mcp$/, "");
  }

  if (!base) base = cleaned;

  const name = formatDisplayName(base);
  const id = slugify(base);
  return { name, id };
}

export function isPlaceholder(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  const v = String(value).trim();
  if (v.length === 0) return true;
  if (v.startsWith("<") && v.endsWith(">")) return true;
  if (/^YOUR[_-]/i.test(v)) return true;
  if (/^<YOUR[_-]/i.test(v)) return true;
  if (/^(TODO|REPLACE_ME|INSERT_YOUR_|ENTER_YOUR_|CHANGEME|FIXME)/i.test(v)) return true;
  if (/^\$\{[^}]+\}$/.test(v)) return true;
  if (/^\$[A-Z0-9_]+$/.test(v)) return true;
  return false;
}

export function isHeaderPlaceholder(value: unknown): boolean {
  if (isPlaceholder(value)) return true;
  const v = String(value).trim();
  if (/^Bearer\s*$/i.test(v)) return true;
  const match = v.match(/^Bearer\s+(.+)$/i);
  if (match) {
    return isPlaceholder(match[1]);
  }
  return false;
}

function splitShellArgs(cmdLine: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let isEscaped = false;

  for (let i = 0; i < cmdLine.length; i++) {
    const ch = cmdLine[i];

    if (isEscaped) {
      current += ch;
      isEscaped = false;
      continue;
    }

    if (ch === "\\") {
      if (inSingleQuote) {
        current += ch;
      } else {
        isEscaped = true;
      }
      continue;
    }

    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    if (/\s/.test(ch) && !inSingleQuote && !inDoubleQuote) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += ch;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

function detectSecrets(transport: PluginTransport): Array<{ key: string; where: "env" | "header" }> {
  const secrets: Array<{ key: string; where: "env" | "header" }> = [];
  if (transport.type === "stdio" && transport.env) {
    for (const [k, v] of Object.entries(transport.env)) {
      if (isPlaceholder(v)) {
        secrets.push({ key: k, where: "env" });
      }
    }
  } else if (transport.type === "http" && transport.headers) {
    for (const [k, v] of Object.entries(transport.headers)) {
      if (isHeaderPlaceholder(v)) {
        secrets.push({ key: k, where: "header" });
      }
    }
  }
  return secrets;
}

function parseServerEntry(
  rawKey: string | undefined,
  entry: any,
  warnings: string[]
): (PluginInput & { needsSecrets: Array<{ key: string; where: "env" | "header" }> }) | null {
  if (!entry || typeof entry !== "object") return null;

  // Determine transport type
  const rawType = typeof entry.type === "string" ? entry.type.toLowerCase() : undefined;
  const isSSE = rawType === "sse";
  const hasUrl = typeof entry.url === "string" || typeof entry.serverUrl === "string";
  const hasCommand = typeof entry.command === "string";

  let transport: PluginTransport | null = null;

  if (isSSE) {
    const serverUrl = String(entry.url || entry.serverUrl || "").trim();
    if (!serverUrl) return null;
    warnings.push(`Server '${rawKey || "imported"}': SSE transport is deprecated and will be treated as HTTP streamable MCP.`);
    const headers: Record<string, string> = {};
    if (entry.headers && typeof entry.headers === "object") {
      for (const [k, v] of Object.entries(entry.headers)) {
        if (typeof v === "string") headers[k] = v;
      }
    }
    transport = {
      type: "http",
      url: serverUrl,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
    };
  } else if (rawType === "http" || (!rawType && hasUrl && !hasCommand)) {
    const serverUrl = String(entry.url || entry.serverUrl || "").trim();
    if (!serverUrl) return null;
    const headers: Record<string, string> = {};
    if (entry.headers && typeof entry.headers === "object") {
      for (const [k, v] of Object.entries(entry.headers)) {
        if (typeof v === "string") headers[k] = v;
      }
    }
    transport = {
      type: "http",
      url: serverUrl,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
    };
  } else if (rawType === "stdio" || (!rawType && hasCommand)) {
    const command = String(entry.command || "").trim();
    if (!command) return null;
    const args: string[] = Array.isArray(entry.args) ? entry.args.map((a: any) => String(a)) : [];
    const env: Record<string, string> = {};
    if (entry.env && typeof entry.env === "object") {
      for (const [k, v] of Object.entries(entry.env)) {
        if (typeof v === "string") env[k] = v;
      }
    }
    transport = {
      type: "stdio",
      command,
      args,
      env: Object.keys(env).length > 0 ? env : undefined,
      cwd: typeof entry.cwd === "string" ? entry.cwd : undefined,
    };
  } else if (entry.transport && typeof entry.transport === "object") {
    // Nested transport object
    return parseServerEntry(rawKey, entry.transport, warnings);
  }

  if (!transport) return null;

  // Derive name and id
  let name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : "";
  let id = typeof entry.id === "string" && entry.id.trim() ? slugify(entry.id) : "";

  if (!name && rawKey) {
    name = formatDisplayName(rawKey);
  }
  if (!id && rawKey) {
    id = slugify(rawKey);
  }

  if (!name && transport.type === "stdio") {
    // Try to extract from package in args
    const pkgArg = transport.args.find((a) => !a.startsWith("-"));
    if (pkgArg) {
      const derived = deriveNameFromPackage(pkgArg);
      name = derived.name;
      if (!id) id = derived.id;
    } else {
      name = formatDisplayName(transport.command);
      if (!id) id = slugify(transport.command);
    }
  } else if (!name && transport.type === "http") {
    try {
      const parsed = new URL(transport.url);
      const hostPart = parsed.hostname.replace(/^(mcp|api)\./, "").split(".")[0];
      name = formatDisplayName(hostPart || "Remote MCP");
      if (!id) id = slugify(hostPart || "remote-mcp");
    } catch {
      name = "HTTP Server";
      if (!id) id = "http-server";
    }
  }

  if (!id) id = slugify(name || "plugin");
  if (!name) name = formatDisplayName(id);

  if (transport.type === "stdio" && transport.command === "docker") {
    warnings.push(`Server '${name}': Docker commands require the Docker socket to be mounted in containerized environments.`);
  }

  const needsSecrets = detectSecrets(transport);

  return {
    id,
    name,
    enabled: typeof entry.enabled === "boolean" ? entry.enabled : true,
    transport,
    trusted: typeof entry.trusted === "boolean" ? entry.trusted : false,
    recipe: typeof entry.recipe === "string" ? entry.recipe : undefined,
    needsSecrets,
  };
}

export function parsePluginImport(text: string): PluginImportResult {
  const warnings: string[] = [];
  const plugins: Array<PluginInput & { needsSecrets: Array<{ key: string; where: "env" | "header" }> }> = [];

  if (!text || typeof text !== "string") {
    return { plugins, warnings };
  }

  const trimmed = text.trim();
  if (!trimmed) {
    return { plugins, warnings };
  }

  // 1. Try Bare URL first (single line, starts with http:// or https://, no spaces)
  if (/^https?:\/\/[^\s]+$/i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      const hostPart = parsed.hostname.replace(/^(mcp|api)\./, "").split(".")[0];
      const name = formatDisplayName(hostPart || "Remote MCP");
      const id = slugify(hostPart || "remote-mcp");
      const transport: PluginTransport = {
        type: "http",
        url: trimmed,
      };
      plugins.push({
        id,
        name,
        enabled: true,
        transport,
        needsSecrets: [],
      });
      return { plugins, warnings };
    } catch {}
  }

  // 2. Try JSON (Claude / Cursor / VS Code / single server object)
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const cleanedJson = stripJsonCommentsAndTrailingCommas(trimmed);
      const data = JSON.parse(cleanedJson);

      if (data && typeof data === "object") {
        // Form A: {"mcpServers": { ... }}
        if (data.mcpServers && typeof data.mcpServers === "object") {
          for (const [key, serverObj] of Object.entries(data.mcpServers)) {
            const parsed = parseServerEntry(key, serverObj, warnings);
            if (parsed) plugins.push(parsed);
          }
          if (plugins.length > 0) {
            return { plugins, warnings };
          }
        }

        // Form B: {"servers": { ... }} (VS Code format)
        if (data.servers && typeof data.servers === "object") {
          for (const [key, serverObj] of Object.entries(data.servers)) {
            const parsed = parseServerEntry(key, serverObj, warnings);
            if (parsed) plugins.push(parsed);
          }
          if (plugins.length > 0) {
            return { plugins, warnings };
          }
        }

        // Form C: Array of servers
        if (Array.isArray(data)) {
          for (let i = 0; i < data.length; i++) {
            const parsed = parseServerEntry(`server-${i + 1}`, data[i], warnings);
            if (parsed) plugins.push(parsed);
          }
          if (plugins.length > 0) {
            return { plugins, warnings };
          }
        }

        // Form D: Single server object { command, args } or { url, headers }
        const single = parseServerEntry(undefined, data, warnings);
        if (single) {
          plugins.push(single);
          return { plugins, warnings };
        }
      }
    } catch {
      // JSON parse failed; fall through to shell command line parsing
    }
  }

  // 3. Try Shell Command Line
  // Supports leading ENV=val assignments, e.g. "FOO=bar BAZ=123 uvx pkg"
  // Supports "npx -y @playwright/mcp@latest"
  // Supports "docker run -i --rm image"
  const tokens = splitShellArgs(trimmed);
  if (tokens.length > 0) {
    const env: Record<string, string> = {};
    let cmdIdx = 0;

    while (cmdIdx < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[cmdIdx])) {
      const token = tokens[cmdIdx];
      const eqIdx = token.indexOf("=");
      const key = token.slice(0, eqIdx);
      const val = token.slice(eqIdx + 1);
      env[key] = val;
      cmdIdx++;
    }

    if (cmdIdx < tokens.length) {
      const command = tokens[cmdIdx];
      const args = tokens.slice(cmdIdx + 1);

      // Verify that this looks like an executable command (not just random prose)
      const commonCommands = new Set([
        "npx",
        "uvx",
        "node",
        "python",
        "python3",
        "docker",
        "pnpx",
        "bunx",
        "deno",
        "go",
        "cargo",
      ]);
      const isPathCommand = command.startsWith("./") || command.startsWith("../") || command.startsWith("/");
      const isKnownRunner = commonCommands.has(command.toLowerCase());
      const isEnvRunner = Object.keys(env).length > 0 && /^[a-z0-9_-]+$/i.test(command);
      const looksLikeCommand = isKnownRunner || isPathCommand || isEnvRunner;

      if (looksLikeCommand) {
        // Derive name and id
        let name = "";
        let id = "";

        if (command === "docker" && args[0] === "run") {
          // Look for docker image name
          // skip flags (-i, -t, --rm, -v <val>, -e <val>, -p <val>, etc.)
          let image = "";
          for (let i = 1; i < args.length; i++) {
            const arg = args[i];
            if (arg === "-v" || arg === "--volume" || arg === "-p" || arg === "--publish") {
              i++; // skip flag value
              continue;
            }
            if (arg === "-e" || arg === "--env") {
              i++;
              if (i < args.length) {
                const envToken = args[i];
                const eq = envToken.indexOf("=");
                if (eq !== -1) {
                  env[envToken.slice(0, eq)] = envToken.slice(eq + 1);
                } else {
                  env[envToken] = "";
                }
              }
              continue;
            }
            if (arg.startsWith("-")) continue;
            image = arg;
            break;
          }
          if (image) {
            const derived = deriveNameFromPackage(image);
            name = derived.name;
            id = derived.id;
          } else {
            name = "Docker Container";
            id = "docker-container";
          }
          warnings.push(`Server '${name}': Docker commands require the Docker socket to be mounted in containerized environments.`);
        } else if (command === "npx" || command === "uvx" || command === "pnpx" || command === "bunx") {
          // Find package name (first non-flag arg)
          const pkgArg = args.find((a) => !a.startsWith("-"));
          if (pkgArg) {
            const derived = deriveNameFromPackage(pkgArg);
            name = derived.name;
            id = derived.id;
          }
        }

        if (!name) {
          name = formatDisplayName(command);
        }
        if (!id) {
          id = slugify(name);
        }

        const transport: PluginTransport = {
          type: "stdio",
          command,
          args,
          env: Object.keys(env).length > 0 ? env : undefined,
        };

        const needsSecrets = detectSecrets(transport);

        plugins.push({
          id,
          name,
          enabled: true,
          transport,
          needsSecrets,
        });

        return { plugins, warnings };
      }
    }
  }

  // Nothing could be parsed
  return { plugins, warnings };
}
