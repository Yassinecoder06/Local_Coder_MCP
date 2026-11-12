/**
 * Agent memory helpers.
 *
 * NOTE: These helpers and tools only change the assistant's own internal scratch state
 * stored under DATA_DIR/agent/<workspace-hash>.json, never the user's workspace files.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { ToolContext, ToolResult } from "../../core/types.js";

export const PLAN_NUDGE_HINT =
  'No current plan for this work — call todo({ action: "set", items: [...] }) (3–7 steps) so the person can follow it in Admin → Requests.';

export function isPlanCurrent(memory: AgentMemory, now = Date.now()): boolean {
  if (!memory || !Array.isArray(memory.todos) || memory.todos.length === 0) return false;
  const validTodos = memory.todos.filter((t) => t && typeof t === "object");
  if (validTodos.length === 0) return false;
  const allDone = validTodos.every((t) => t.status === "done");
  if (allDone) return false;
  const parsedTime = Date.parse(memory.updatedAt);
  if (isNaN(parsedTime)) return false;
  const ageMs = now - parsedTime;
  if (ageMs > 2 * 3600 * 1000) return false;
  return true;
}

const workspaceLastNudgedAt = new Map<string, number>();

export function getSessionNudged(ctx: ToolContext): Set<string> {
  if (!ctx.sessionNudged) {
    ctx.sessionNudged = new Set<string>();
  }
  return ctx.sessionNudged;
}

export function shouldNudgeWorkspace(
  ctx: ToolContext,
  workspacePath: string,
  now = Date.now()
): boolean {
  if (!ctx.board) return false;
  const resolvedWs = path.resolve(workspacePath);
  const sessionNudged = getSessionNudged(ctx);
  if (sessionNudged.has(resolvedWs)) return false;
  const lastNudge = workspaceLastNudgedAt.get(resolvedWs) ?? 0;
  if (now - lastNudge < 30 * 60 * 1000) return false;
  return true;
}

export function recordPlanNudge(
  ctx: ToolContext,
  workspacePath: string,
  now = Date.now()
): void {
  const resolvedWs = path.resolve(workspacePath);
  const sessionNudged = getSessionNudged(ctx);
  sessionNudged.add(resolvedWs);
  workspaceLastNudgedAt.set(resolvedWs, now);
}

export function resetPlanNudgeTracking(ctx?: ToolContext): void {
  workspaceLastNudgedAt.clear();
  if (ctx?.sessionNudged) {
    ctx.sessionNudged.clear();
  }
}

export async function maybeApplyPlanNudge(opts: {
  toolName: string;
  toolRisk?: string;
  args: any;
  result: ToolResult;
  ctx: ToolContext;
  sessionNudged?: Set<string>;
}): Promise<boolean> {
  try {
    if (!opts.result.ok) return false;
    if (!opts.ctx.board) return false;

    // Never inside todo/resume/finish themselves or exec
    if (["todo", "resume", "finish", "exec"].includes(opts.toolName)) return false;

    // Changing tool: risk "write" or "exec" per tool definitions
    const isChanging = opts.toolRisk === "write" || opts.toolRisk === "exec";
    if (!isChanging) return false;

    // Run with command that is not verify
    if (opts.toolName === "run" && opts.args && opts.args.verify === true) {
      return false;
    }

    const workspaceRoot = opts.ctx.workspace.active();
    const now = Date.now();

    if (!shouldNudgeWorkspace(opts.ctx, workspaceRoot, now)) return false;

    // When active workspace plan is empty, all done, or not updated in the last 2 h
    const memory = await getAgentMemory(opts.ctx.config.dataDir, workspaceRoot);
    if (isPlanCurrent(memory, now)) return false;

    recordPlanNudge(opts.ctx, workspaceRoot, now);
    opts.result.summary = opts.result.summary
      ? `${opts.result.summary}\n${PLAN_NUDGE_HINT}`
      : PLAN_NUDGE_HINT;
    return true;
  } catch {
    return false;
  }
}

export interface TodoItem {
  id: string;
  text: string;
  status: "pending" | "in_progress" | "done";
}

export interface AgentMemory {
  workspace: string;
  updatedAt: string;
  todos: TodoItem[];
}

export interface AgentPlan extends AgentMemory {
  open: number;
  orphaned?: boolean;
}

export interface NewerWorkspacePlan {
  workspace: string;
  updatedAt: string;
  age: string;
  open: number;
}

export function formatRelativeAge(dateStrOrMs: string | number, now = Date.now()): string {
  const time = typeof dateStrOrMs === "number" ? dateStrOrMs : Date.parse(dateStrOrMs);
  if (isNaN(time)) return "unknown";
  const diffMs = Math.max(0, now - time);
  if (diffMs < 60000) {
    return "just now";
  }
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 60) {
    return `${minutes} m ago`;
  }
  const hours = Math.round(diffMs / (3600 * 1000));
  if (hours < 48) {
    return `${hours} h ago`;
  }
  const days = Math.round(diffMs / (24 * 3600 * 1000));
  return `${days} d ago`;
}

export function getWorkspaceHash(workspaceRoot: string): string {
  return createHash("sha256").update(path.resolve(workspaceRoot)).digest("hex").slice(0, 16);
}

export async function getAgentMemory(dataDir: string, workspaceRoot: string): Promise<AgentMemory> {
  const hash = getWorkspaceHash(workspaceRoot);
  const memoryFile = path.join(dataDir, "agent", `${hash}.json`);
  try {
    const raw = await fs.readFile(memoryFile, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return {
        workspace: workspaceRoot,
        updatedAt: new Date().toISOString(),
        todos: [],
      };
    }
    const rawTodos = Array.isArray(parsed.todos) ? parsed.todos : [];
    const todos: TodoItem[] = rawTodos
      .filter((t: any) => t && typeof t === "object" && typeof t.text === "string")
      .map((t: any, idx: number) => ({
        id: typeof t.id === "string" ? t.id : String(idx + 1),
        text: t.text,
        status: t.status === "done" || t.status === "in_progress" ? t.status : "pending",
      }));
    return {
      workspace: typeof parsed.workspace === "string" ? parsed.workspace : workspaceRoot,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
      todos,
    };
  } catch {
    return {
      workspace: workspaceRoot,
      updatedAt: new Date().toISOString(),
      todos: [],
    };
  }
}

export async function listAgentPlans(dataDir: string, limit = 50): Promise<AgentPlan[]> {
  const directory = path.join(dataDir, "agent");
  let entries: string[];
  try {
    entries = await fs.readdir(directory);
  } catch {
    return [];
  }

  const plans = await Promise.all(entries.filter((entry) => entry.endsWith(".json")).map(async (entry) => {
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(directory, entry), "utf-8"));
      if (typeof parsed.workspace !== "string" || !Array.isArray(parsed.todos) || parsed.todos.length === 0) return undefined;
      const todos = parsed.todos as TodoItem[];
      const plan: AgentPlan = {
        workspace: parsed.workspace,
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
        todos,
        open: todos.filter((todo) => todo?.status !== "done").length,
        ...(parsed.orphaned === true ? { orphaned: true } : {}),
      } satisfies AgentPlan;
      return plan;
    } catch {
      return undefined;
    }
  }));

  return plans.filter((plan): plan is AgentPlan => Boolean(plan))
    .sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0))
    .slice(0, Math.max(0, limit));
}

export async function findNewerWorkspacePlans(
  dataDir: string,
  currentWorkspace: string,
  currentUpdatedAt: string,
  limit = 3
): Promise<NewerWorkspacePlan[]> {
  const currentMs = Date.parse(currentUpdatedAt) || 0;
  const currentResolved = path.resolve(currentWorkspace);
  const allPlans = await listAgentPlans(dataDir);
  const results: NewerWorkspacePlan[] = [];

  for (const plan of allPlans) {
    if (path.resolve(plan.workspace) === currentResolved) continue;
    const planMs = Date.parse(plan.updatedAt) || 0;
    if (planMs <= currentMs) continue;

    // Skip workspaces whose folder no longer exists
    try {
      const stat = await fs.stat(plan.workspace);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }

    results.push({
      workspace: plan.workspace,
      updatedAt: plan.updatedAt,
      age: formatRelativeAge(plan.updatedAt),
      open: plan.open,
    });

    if (results.length >= limit) break;
  }

  return results;
}

export async function saveAgentMemory(
  dataDir: string,
  workspaceRoot: string,
  memory: AgentMemory
): Promise<void> {
  const hash = getWorkspaceHash(workspaceRoot);
  const dir = path.join(dataDir, "agent");
  await fs.mkdir(dir, { recursive: true });
  const memoryFile = path.join(dir, `${hash}.json`);
  const now = new Date().toISOString();
  memory.updatedAt = now;
  const data = JSON.stringify(
    {
      ...memory,
      workspace: workspaceRoot,
      updatedAt: now,
    },
    null,
    2
  );
  await fs.writeFile(memoryFile, data, "utf-8");
}

/** Clear a workspace plan using the same agent memory file used by the todo tool. */
export async function clearAgentTodos(dataDir: string, workspaceRoot: string): Promise<void> {
  const memory = await getAgentMemory(dataDir, workspaceRoot);
  await saveAgentMemory(dataDir, workspaceRoot, { ...memory, todos: [] });
}
