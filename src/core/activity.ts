/**
 * CONTRACT (interface) owned by orchestrator; implementation owned by agy1 (core).
 * In-memory ring buffer of tool calls + pub/sub for the UI live feed (SSE),
 * persisted as JSONL in DATA_DIR/activity.jsonl.
 */
import fs from "node:fs";
import path from "node:path";

export interface ActivityEntry {
  id: number;
  ts: string; // ISO time
  session?: string; // first 8 chars of MCP session id
  client?: string; // "chatgpt" | "gemini" | other clientInfo.name
  tool: string;
  args?: string; // short summary, never secrets
  ok: boolean;
  summary: string;
  ms: number;
  /** Active workspace root when the call finished. */
  workspace?: string;
  /** Set on calls made from inside `exec`: the `exec` call's own activity id is not known yet, so this is "exec". */
  via?: "exec";
}

export interface ActivityLog {
  record(entry: Omit<ActivityEntry, "id" | "ts">): ActivityEntry;
  recent(limit?: number): ActivityEntry[];
  subscribe(fn: (e: ActivityEntry) => void): () => void;
}

export function createActivityLog(filePath?: string, max = 500): ActivityLog {
  const items: ActivityEntry[] = [];
  const subs = new Set<(e: ActivityEntry) => void>();
  let seq = 0;

  if (filePath) {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      if (fs.existsSync(filePath)) {
        const lines = fs.readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
        for (const line of lines.slice(-max)) {
          try {
            const entry = JSON.parse(line) as ActivityEntry;
            items.push(entry);
            if (entry.id > seq) seq = entry.id;
          } catch {}
        }
      }
    } catch (err) {
      console.warn("[activity] Could not load existing activity log:", err);
    }
  }

  return {
    record(entry) {
      const e: ActivityEntry = {
        ...entry,
        id: ++seq,
        ts: new Date().toISOString(),
      };
      items.push(e);
      if (items.length > max) items.shift();

      subs.forEach((fn) => {
        try {
          fn(e);
        } catch (err) {
          console.warn("[activity] Error in subscriber:", err);
        }
      });

      if (filePath) {
        fs.appendFile(filePath, JSON.stringify(e) + "\n", (err) => {
          if (err) console.error("[activity] Failed to append entry:", err);
        });
      }

      return e;
    },
    recent: (limit = 100) => items.slice(-limit).reverse(),
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

export function createMemoryActivityLog(max = 500): ActivityLog {
  return createActivityLog(undefined, max);
}
