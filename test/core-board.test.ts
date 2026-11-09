import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBoard, type BoardEvent } from "../src/core/board.js";

test("board: requests, dedupe, status, finish, events, persistence", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "board-"));
  try {
    const board = createBoard(dir);
    const events: BoardEvent[] = [];
    board.subscribe((e) => events.push(e));
    const base = { workspace: "/w", cwd: "/w", purpose: "install", command: "sudo apt install jq" };
    const a = await board.addRequest(base);
    const b = await board.addRequest(base);
    assert.equal(a.id, b.id, "same open command+cwd is deduped");
    assert.equal(a.status, "open");
    await assert.rejects(board.addRequest({ ...base, command: "x".repeat(9000) }), /8 KB/);
    await assert.rejects(board.addRequest({ ...base, command: "y", expectedFiles: Array(11).fill("/f") }), /10 expected/);
    const done = await board.setRequestStatus(a.id, "done", "ok");
    assert.equal(done.status, "done");
    assert.equal(done.note, "ok");
    const fin = await board.addFinish({ workspace: "/w", summary: "s", changedFiles: [], evidence: { openRequests: 0 }, verified: false, warnings: [] });
    board.emitPlan("/w", [{ id: "1", text: "t", status: "pending" }]);
    assert.deepEqual(events.map((e) => e.type), ["request", "request", "finish", "plan"]);
    const again = createBoard(dir);
    assert.equal((await again.listRequests({ status: "done" })).length, 1);
    assert.equal((await again.listFinishes())[0].id, fin.id);
    // concurrent adds are serialised, none lost
    await Promise.all(Array.from({ length: 5 }, (_, i) => again.addRequest({ ...base, command: `c${i}` })));
    assert.equal((await again.listRequests({ status: "open" })).length, 5);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
