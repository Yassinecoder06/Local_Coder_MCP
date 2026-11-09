/**
 * Owned by agy1. Manages stateful McpServer sessions with transparent recovery.
 */
import crypto from "node:crypto";
import type { Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  isInitializeRequest,
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { AppConfig } from "../config.js";
import type { ActivityLog } from "../core/activity.js";
import type { Board } from "../core/board.js";
import type { CommandRegistry } from "../commands/registry.js";
import type { SkillRegistry } from "../skills/registry.js";
import { createWorkspace, resolveInitialWorkspace, resolveWorkspaces } from "../core/workspace.js";
import type { ToolContext, ToolRisk } from "../core/types.js";
import { annotationsFor, type ApprovalMode } from "../core/annotations.js";
import { getSettings, updateSettings } from "../core/settings.js";
import toolModules from "../tools/index.js";
import { buildInstructions } from "../mcp/instructions.js";
import { createMcpServer } from "../mcp/server.js";

const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour idle TTL
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export type ServerFactory = (
  context: ToolContext,
  sessionId: string,
  getHeaders?: () => { userAgent?: string; origin?: string } | undefined
) => Promise<McpServer | Server>;

export interface McpSession {
  sessionId: string;
  transport: StreamableHTTPServerTransport;
  server: McpServer | Server;
  context: ToolContext;
  createdAt: number;
  lastAccessedAt: number;
  latestHeaders?: { userAgent?: string; origin?: string };
}

export interface SessionManagerDependencies {
  config: AppConfig;
  activity: ActivityLog;
  skills: SkillRegistry;
  commands: CommandRegistry;
  board?: Board;
  serverFactory?: ServerFactory;
}

function negotiateProtocolVersion(requested?: string): string {
  if (requested && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)) {
    return requested;
  }
  return LATEST_PROTOCOL_VERSION;
}

function patchSessionHeaders(req: Request, sessionId: string, protocolVersion: string): void {
  req.headers["mcp-session-id"] = sessionId;
  req.headers["mcp-protocol-version"] = protocolVersion;

  const drop = new Set(["mcp-session-id", "mcp-protocol-version"]);
  const raw: string[] = [];
  const existing = req.rawHeaders || [];
  for (let i = 0; i < existing.length; i += 2) {
    if (drop.has(existing[i]?.toLowerCase())) continue;
    raw.push(existing[i], existing[i + 1]);
  }
  raw.push("mcp-session-id", sessionId, "mcp-protocol-version", protocolVersion);
  req.rawHeaders = raw;
}

export class SessionManager {
  private sessions = new Map<string, McpSession>();
  private sessionOpChains = new Map<string, Promise<void>>();
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(private deps: SessionManagerDependencies) {}

  public get(sessionId: string): McpSession | undefined {
    return this.sessions.get(sessionId);
  }

  public touch(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) {
      s.lastAccessedAt = Date.now();
    }
  }

  public count(): number {
    return this.sessions.size;
  }

  public async applyApprovalModeLive(newMode: ApprovalMode): Promise<void> {
    const toolDefMap = new Map<string, { risk: ToolRisk; title: string }>();
    for (const tool of (toolModules ?? []).flat()) {
      if (tool?.name) {
        toolDefMap.set(tool.name, { risk: tool.risk, title: tool.title });
      }
    }

    for (const session of this.sessions.values()) {
      const regTools = (session.server as any)._registeredTools;
      if (regTools) {
        for (const [name, regTool] of Object.entries(regTools)) {
          if (!regTool) continue;
          const def = toolDefMap.get(name);
          const risk = def?.risk ?? "read";
          const title = (regTool as any).title ?? def?.title ?? name;
          const annotations = annotationsFor(risk, title, newMode);
          (regTool as any).update({ annotations });
        }
      }

      // Update instructions on the session server
      try {
        const newInstructions = await buildInstructions(session.context);
        const s = session.server as any;
        if (s.server) s.server._instructions = newInstructions;
        else s._instructions = newInstructions;
      } catch {}

      // Send notifications/tools/list_changed
      try {
        (session.server as any).sendToolListChanged();
      } catch {}
    }
  }

  public async applyWorkspacesLive(): Promise<void> {
    const effective = resolveWorkspaces(this.deps.config, getSettings());
    for (const session of this.sessions.values()) {
      const ws = session.context.workspace as any;
      if (ws.updateRoots) {
        ws.updateRoots(effective.roots, effective.defaultWorkspace);
      }
      try {
        const newInstructions = await buildInstructions(session.context);
        const s = session.server as any;
        if (s.server) s.server._instructions = newInstructions;
        else s._instructions = newInstructions;
      } catch {}
      try {
        (session.server as any).sendToolListChanged();
      } catch {}
    }
  }

  public notifyToolListChanged(newInstructions?: string): void {
    for (const session of this.sessions.values()) {
      if (newInstructions !== undefined) {
        (session.server as any)._instructions = newInstructions;
      }
      try {
        (session.server as any).sendToolListChanged();
      } catch {}
    }
  }

  public async buildSession(forcedSessionId?: string, clientInfo?: { name: string; version: string }): Promise<McpSession> {
    const sessionId = forcedSessionId || crypto.randomUUID();
    const settings = getSettings();
    const effective = resolveWorkspaces(this.deps.config, settings);
    const initialWorkspace = resolveInitialWorkspace(
      effective.roots,
      effective.defaultWorkspace,
      settings.lastWorkspace
    );
    const workspace = createWorkspace(
      effective.roots,
      initialWorkspace,
      (newActive) => {
        void updateSettings({ lastWorkspace: newActive }).catch((err) => {
          console.warn("[workspace] Failed to persist lastWorkspace:", err);
        });
      },
      () => resolveWorkspaces(this.deps.config, getSettings()).roots
    );
    const context: ToolContext = {
      config: this.deps.config,
      workspace,
      skills: this.deps.skills,
      commands: this.deps.commands,
      activity: this.deps.activity,
      board: this.deps.board,
    };

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => sessionId,
      enableJsonResponse: true,
      onsessioninitialized: (sid) => {
        const existing = this.sessions.get(sid);
        if (existing) {
          existing.lastAccessedAt = Date.now();
        }
      },
      onsessionclosed: (sid) => {
        if (sid) {
          this.removeSession(sid, "client closed");
        }
      },
    });

    let sessionRef: McpSession | undefined;
    const factory = this.deps.serverFactory ?? createMcpServer;
    const server = await factory(context, sessionId, () => sessionRef?.latestHeaders);
    await server.connect(transport);

    if (forcedSessionId) {
      // Force transport session initialization for stale recovery
      const webTransport = (transport as any)._webStandardTransport;
      if (webTransport) {
        webTransport.sessionId = forcedSessionId;
        webTransport._initialized = true;
      }
    }

    const session: McpSession = {
      sessionId,
      transport,
      server,
      context,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
    };
    sessionRef = session;

    this.sessions.set(sessionId, session);
    return session;
  }

  public removeSession(sessionId: string, reason: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    this.sessionOpChains.delete(sessionId);
    void session.transport.close().catch(() => undefined);
  }

  private async enqueueOp(sessionId: string, op: () => Promise<void>): Promise<void> {
    const prev = this.sessionOpChains.get(sessionId) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(op);
    this.sessionOpChains.set(sessionId, run);
    try {
      await run;
    } finally {
      if (this.sessionOpChains.get(sessionId) === run) {
        this.sessionOpChains.delete(sessionId);
      }
    }
  }

  public async handleRequest(req: Request, res: Response): Promise<void> {
    const rawSid = req.headers["mcp-session-id"] as string | undefined;
    const protocolVersion = negotiateProtocolVersion(req.headers["mcp-protocol-version"] as string | undefined);

    // Normalize accept header so strict SDK checks won't fail
    const accept = req.headers["accept"] || "";
    if (!accept.includes("application/json") || !accept.includes("text/event-stream")) {
      req.headers["accept"] = (accept ? `${accept}, ` : "") + "application/json, text/event-stream";
    }

    const isInit = isInitializeRequest(req.body);

    let session: McpSession | undefined;

    if (isInit) {
      // Initialization creates a fresh session
      session = await this.buildSession();
    } else if (rawSid && this.sessions.has(rawSid)) {
      // Existing session
      session = this.sessions.get(rawSid)!;
    } else if (rawSid && !this.sessions.has(rawSid)) {
      // Transparent recovery: re-create session with the requested stale session ID
      session = await this.buildSession(rawSid);
    } else {
      // Request without a session ID that is NOT initialize: serve with a fresh session
      const newSid = crypto.randomUUID();
      session = await this.buildSession(newSid);
    }

    const sid = session.sessionId;
    const userAgent = req.headers["user-agent"] as string | undefined;
    const origin = req.headers["origin"] as string | undefined;
    session.latestHeaders = { userAgent, origin };

    this.touch(sid);
    patchSessionHeaders(req, sid, protocolVersion);
    res.setHeader("mcp-session-id", sid);

    const execute = async () => {
      await session!.transport.handleRequest(req, res, req.body);
    };

    // Sequential queue for POST/DELETE, concurrent for GET (SSE stream)
    if (req.method !== "GET") {
      await this.enqueueOp(sid, execute);
    } else {
      await execute();
    }
  }

  public startCleanup(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [sid, session] of this.sessions.entries()) {
        if (now - session.lastAccessedAt > SESSION_TTL_MS) {
          this.removeSession(sid, "idle TTL expired");
        }
      }
    }, CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref?.();
  }

  public stopCleanup(): void {
    if (!this.cleanupTimer) return;
    clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
  }
}
