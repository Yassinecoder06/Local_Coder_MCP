/**
 * SHARED CONTRACT + implementation — owned by the orchestrator.
 *
 * The "board" holds things the model hands to the person and what it reports back:
 *   - user requests (`ask_user`): one exact step for the person to run; the server never runs it;
 *   - finish reports (`finish`): the model's "done" claim with the evidence the server checked;
 *   - plan events: the `todo` tool emits the current plan so the admin UI can show it live.
 * Persisted in DATA_DIR/board.json. Tools reach it via ToolContext.board; the admin API via deps.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type RequestStatus = "open" | "done" | "skipped";

export interface UserRequest {
  id: string;
  createdAt: string;
  updatedAt: string;
  session?: string;
  client?: string;
  workspace: string;
  /** Exact command for the person to run (≤ 8 KB). */
  command: string;
  /** Folder to run it in (absolute). */
  cwd: string;
  /** One line: why the model needs this. */
  purpose: string;
  /** Files the step should leave behind (≤ 10, absolute). */
  expectedFiles: string[];
  constraints?: string;
  status: RequestStatus;
  /** Optional note from the person when marking done/skipped. */
  note?: string;
}

export interface FinishEvidence {
  /** Most recent `run verify:true` in this workspace, if any. */
  verify?: { ok: boolean; at: string; summary: string };
  /** Most recent `browser_check`, if any. */
  browserCheck?: { ok: boolean; at: string; summary: string };
  /** `git diff --stat` style counts at finish time, if a git repo. */
  git?: { files: number; insertions: number; deletions: number; branch?: string };
  /** Open user requests at finish time. */
  openRequests: number;
}

export interface FinishReport {
  id: string;
  createdAt: string;
  session?: string;
  client?: string;
  workspace: string;
  summary: string;
  changedFiles: string[];
  evidence: FinishEvidence;
  /** true when the server found passing evidence (verify ok or browser_check ok) and no open requests. */
  verified: boolean;
  warnings: string[];
}

export type BoardEvent =
  | { type: "request"; request: UserRequest }
  | { type: "finish"; finish: FinishReport }
  | { type: "plan"; workspace: string; session?: string; todos: unknown[] };

export interface NewRequest {
  session?: string;
  client?: string;
  workspace: string;
  command: string;
  cwd: string;
  purpose: string;
  expectedFiles?: string[];
  constraints?: string;
}

export interface Board {
  /** Adds an open request. Same open command+cwd in the workspace returns the existing one. Max 20 open per workspace. */
  addRequest(input: NewRequest): Promise<UserRequest>;
  listRequests(filter?: { workspace?: string; status?: RequestStatus }): Promise<UserRequest[]>;
  getRequest(id: string): Promise<UserRequest | undefined>;
  /** Only the person (admin API) calls this. */
  setRequestStatus(id: string, status: "done" | "skipped", note?: string): Promise<UserRequest>;
  addFinish(report: Omit<FinishReport, "id" | "createdAt">): Promise<FinishReport>;
  /** Newest first. */
  listFinishes(filter?: { workspace?: string; limit?: number }): Promise<FinishReport[]>;
  emitPlan(workspace: string, todos: unknown[], session?: string): void;
  subscribe(fn: (ev: BoardEvent) => void): () => void;
}

export const BOARD_LIMITS = Object.freeze({ commandBytes: 8 * 1024, expectedFiles: 10, openPerWorkspace: 20, finishesKept: 200, closedRequestsKept: 500 });

interface BoardFile {
  requests: UserRequest[];
  finishes: FinishReport[];
}

export function createBoard(dataDir: string): Board {
  const file = path.join(dataDir, "board.json");
  const listeners = new Set<(ev: BoardEvent) => void>();
  let state: BoardFile | undefined;
  let chain: Promise<unknown> = Promise.resolve();

  async function load(): Promise<BoardFile> {
    if (state) return state;
    try {
      const parsed = JSON.parse(await fs.readFile(file, "utf8"));
      state = {
        requests: Array.isArray(parsed.requests) ? parsed.requests : [],
        finishes: Array.isArray(parsed.finishes) ? parsed.finishes : [],
      };
    } catch {
      state = { requests: [], finishes: [] };
    }
    return state;
  }

  async function save(s: BoardFile): Promise<void> {
    const open = s.requests.filter((r) => r.status === "open");
    const closed = s.requests.filter((r) => r.status !== "open").slice(-BOARD_LIMITS.closedRequestsKept);
    s.requests = [...closed, ...open].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    s.finishes = s.finishes.slice(-BOARD_LIMITS.finishesKept);
    await fs.mkdir(dataDir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(s, null, 2));
    await fs.rename(tmp, file);
  }

  /** Serialise mutations so concurrent tool calls never lose writes. */
  function locked<T>(fn: (s: BoardFile) => Promise<T>): Promise<T> {
    const next = chain.then(async () => fn(await load()));
    chain = next.catch(() => undefined);
    return next;
  }

  function emit(ev: BoardEvent): void {
    for (const fn of listeners) {
      try {
        fn(ev);
      } catch {
        /* a broken listener must not break the board */
      }
    }
  }

  return {
    addRequest: (input) =>
      locked(async (s) => {
        const command = input.command.trim();
        if (!command) throw new Error("command is required");
        if (Buffer.byteLength(command) > BOARD_LIMITS.commandBytes) throw new Error("command is larger than 8 KB");
        const expectedFiles = (input.expectedFiles ?? []).slice(0, BOARD_LIMITS.expectedFiles + 1);
        if (expectedFiles.length > BOARD_LIMITS.expectedFiles) throw new Error("at most 10 expected files");
        const open = s.requests.filter((r) => r.status === "open" && r.workspace === input.workspace);
        const same = open.find((r) => r.command === command && r.cwd === input.cwd);
        if (same) return same;
        if (open.length >= BOARD_LIMITS.openPerWorkspace) throw new Error("20 open requests already; ask the person to finish or skip some first");
        const now = new Date().toISOString();
        const req: UserRequest = {
          id: randomUUID().slice(0, 8),
          createdAt: now,
          updatedAt: now,
          session: input.session,
          client: input.client,
          workspace: input.workspace,
          command,
          cwd: input.cwd,
          purpose: input.purpose.trim(),
          expectedFiles,
          constraints: input.constraints?.trim() || undefined,
          status: "open",
        };
        s.requests.push(req);
        await save(s);
        emit({ type: "request", request: req });
        return req;
      }),

    listRequests: async (filter) => {
      const s = await load();
      return s.requests.filter(
        (r) => (!filter?.workspace || r.workspace === filter.workspace) && (!filter?.status || r.status === filter.status)
      );
    },

    getRequest: async (id) => (await load()).requests.find((r) => r.id === id),

    setRequestStatus: (id, status, note) =>
      locked(async (s) => {
        const req = s.requests.find((r) => r.id === id);
        if (!req) throw new Error(`request not found: ${id}`);
        req.status = status;
        req.updatedAt = new Date().toISOString();
        if (note?.trim()) req.note = note.trim().slice(0, 2000);
        await save(s);
        emit({ type: "request", request: req });
        return req;
      }),

    addFinish: (report) =>
      locked(async (s) => {
        const fin: FinishReport = { ...report, id: randomUUID().slice(0, 8), createdAt: new Date().toISOString() };
        s.finishes.push(fin);
        await save(s);
        emit({ type: "finish", finish: fin });
        return fin;
      }),

    listFinishes: async (filter) => {
      const s = await load();
      return s.finishes
        .filter((f) => !filter?.workspace || f.workspace === filter.workspace)
        .slice()
        .reverse()
        .slice(0, filter?.limit ?? 20);
    },

    emitPlan: (workspace, todos, session) => emit({ type: "plan", workspace, session, todos }),

    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
