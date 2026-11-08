/**
 * CONTRACT (interface) owned by orchestrator; implementation owned by agy1 (core).
 * In-memory ring buffer of tool calls + pub/sub for the UI live feed (SSE),
 * persisted as JSONL in DATA_DIR/activity.jsonl.
 */
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
}

export interface ActivityLog {
  record(entry: Omit<ActivityEntry, "id" | "ts">): ActivityEntry;
  recent(limit?: number): ActivityEntry[];
  subscribe(fn: (e: ActivityEntry) => void): () => void;
}

export function createMemoryActivityLog(max = 500): ActivityLog {
  const items: ActivityEntry[] = [];
  const subs = new Set<(e: ActivityEntry) => void>();
  let seq = 0;
  return {
    record(entry) {
      const e = { ...entry, id: ++seq, ts: new Date().toISOString() };
      items.push(e);
      if (items.length > max) items.shift();
      subs.forEach((fn) => fn(e));
      return e;
    },
    recent: (limit = 100) => items.slice(-limit).reverse(),
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}
