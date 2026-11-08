/**
 * SHARED CONTRACT — owned by the orchestrator. All runtime configuration comes
 * from environment variables (see .env.example). Keep this file the single
 * source of truth; never read process.env elsewhere.
 */
import path from "node:path";
import { z } from "zod";

const list = (v: string | undefined) =>
  (v ?? "")
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => path.resolve(p));

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? fallback : !["0", "false", "no", "off"].includes(v.toLowerCase())));

const Env = z.object({
  PORT: z.coerce.number().int().default(8787),
  ADMIN_PORT: z.coerce.number().int().default(8788),
  HOST: z.string().default("127.0.0.1"),
  ADMIN_HOST: z.string().default("127.0.0.1"),
  /** Secret access key. Accepted as `Authorization: Bearer`, `/mcp/<token>` path, or via OAuth login. */
  MCP_TOKEN: z.string().default(""),
  /** Public base URL (tunnel), used as OAuth issuer and shown in the UI. Optional. */
  PUBLIC_URL: z.string().default(""),
  /** cloudflared metrics base (e.g. http://tunnel:2000); when set and PUBLIC_URL is empty, the quick-tunnel URL is auto-discovered from <base>/quicktunnel. */
  TUNNEL_METRICS_URL: z.string().default(""),
  /** token = URL/bearer token only; oauth = OAuth 2.1 + DCR only; both = either (default); none = no auth (local only!). */
  AUTH_MODE: z.enum(["token", "oauth", "both", "none"]).default("both"),
  WORKSPACE_ROOTS: z.string().optional(),
  DEFAULT_WORKSPACE: z.string().optional(),
  DATA_DIR: z.string().default("./data"),
  /** Built-in skills shipped in the repo (read-only) + user skills dir (writable, first entry of USER_SKILLS_DIR). */
  BUILTIN_SKILLS_DIR: z.string().default("./skills"),
  USER_SKILLS_DIR: z.string().default("./data/skills"),
  EXTRA_SKILLS_DIRS: z.string().optional(),
  BUILTIN_COMMANDS_DIR: z.string().default("./commands"),
  USER_COMMANDS_DIR: z.string().default("./data/commands"),
  /** minimal = annotate tools to minimise confirmation prompts (default); standard = conservative annotations. */
  APPROVAL_MODE: z.enum(["minimal", "standard"]).default("minimal"),
  /** essential = ~20 consolidated tools (best for web chat); full = everything. */
  TOOL_PROFILE: z.enum(["essential", "full"]).default("essential"),
  SHELL_TIMEOUT_MS: z.coerce.number().int().default(120_000),
  /** Commands that return within this window are synchronous; longer ones keep running in the background. */
  SHELL_SYNC_MS: z.coerce.number().int().default(15_000),
  MAX_OUTPUT_BYTES: z.coerce.number().int().default(60_000),
  CHECKPOINTS: bool(true),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export interface AppConfig {
  port: number;
  adminPort: number;
  host: string;
  adminHost: string;
  mcpToken: string;
  publicUrl: string;
  tunnelMetricsUrl: string;
  authMode: "token" | "oauth" | "both" | "none";
  workspaceRoots: string[];
  defaultWorkspace: string;
  dataDir: string;
  builtinSkillsDir: string;
  userSkillsDir: string;
  extraSkillsDirs: string[];
  builtinCommandsDir: string;
  userCommandsDir: string;
  approvalMode: "minimal" | "standard";
  toolProfile: "essential" | "full";
  shellTimeoutMs: number;
  shellSyncMs: number;
  maxOutputBytes: number;
  checkpoints: boolean;
  logLevel: "debug" | "info" | "warn" | "error";
  version: string;
}

export const VERSION = "1.0.0";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const e = Env.parse(env);
  const roots = list(e.WORKSPACE_ROOTS);
  const workspaceRoots = roots.length ? roots : [process.cwd()];
  return {
    port: e.PORT,
    adminPort: e.ADMIN_PORT,
    host: e.HOST,
    adminHost: e.ADMIN_HOST,
    mcpToken: e.MCP_TOKEN.trim(),
    publicUrl: e.PUBLIC_URL.replace(/\/+$/, ""),
    tunnelMetricsUrl: e.TUNNEL_METRICS_URL.replace(/\/+$/, ""),
    authMode: e.AUTH_MODE,
    workspaceRoots,
    defaultWorkspace: e.DEFAULT_WORKSPACE ? path.resolve(e.DEFAULT_WORKSPACE) : workspaceRoots[0],
    dataDir: path.resolve(e.DATA_DIR),
    builtinSkillsDir: path.resolve(e.BUILTIN_SKILLS_DIR),
    userSkillsDir: path.resolve(e.USER_SKILLS_DIR),
    extraSkillsDirs: list(e.EXTRA_SKILLS_DIRS),
    builtinCommandsDir: path.resolve(e.BUILTIN_COMMANDS_DIR),
    userCommandsDir: path.resolve(e.USER_COMMANDS_DIR),
    approvalMode: e.APPROVAL_MODE,
    toolProfile: e.TOOL_PROFILE,
    shellTimeoutMs: e.SHELL_TIMEOUT_MS,
    shellSyncMs: e.SHELL_SYNC_MS,
    maxOutputBytes: e.MAX_OUTPUT_BYTES,
    checkpoints: e.CHECKPOINTS,
    logLevel: e.LOG_LEVEL,
    version: VERSION,
  };
}
