/**
 * Agent memory helpers.
 *
 * NOTE: These helpers and tools only change the assistant's own internal scratch state
 * stored under DATA_DIR/agent/<workspace-hash>.json, never the user's workspace files.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

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
    return {
      workspace: parsed.workspace || workspaceRoot,
      updatedAt: parsed.updatedAt || new Date().toISOString(),
      todos: Array.isArray(parsed.todos) ? parsed.todos : [],
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
      return {
        workspace: parsed.workspace,
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
        todos,
        open: todos.filter((todo) => todo?.status !== "done").length,
      } satisfies AgentPlan;
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
