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
