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
  orphaned?: boolean;
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

export async function saveAgentMemory(
  dataDir: string,
  workspaceRoot: string,
  memory: AgentMemory
): Promise<void> {
  const hash = getWorkspaceHash(workspaceRoot);
  const dir = path.join(dataDir, "agent");
  await fs.mkdir(dir, { recursive: true });
  const memoryFile = path.join(dir, `${hash}.json`);
  const data = JSON.stringify(
    {
      ...memory,
      workspace: workspaceRoot,
      updatedAt: new Date().toISOString(),
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
