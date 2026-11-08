import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createTestEnvironment } from "./helpers.js";
import { gitTool, gitWriteTool } from "../src/tools/git.js";

const execFileAsync = promisify(execFile);

test("git tools: read-only git vs git_write", async (t) => {
  const env = await createTestEnvironment();

  t.after(async () => {
    await env.cleanup();
  });

  // Setup git repo in workspace
  await execFileAsync("git", ["init", "-b", "main"], { cwd: env.workspaceDir });
  await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: env.workspaceDir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: env.workspaceDir });

  await t.test("git status on clean repository", async () => {
    const res = await gitTool.handler({ subcommand: "status" }, env.ctx);
    assert.equal(res.ok, true);
    assert.match(res.data.output, /On branch main/);
  });

  await t.test("git_write add and commit", async () => {
    await fs.writeFile(path.join(env.workspaceDir, "file.txt"), "hello git\n", "utf-8");

    // Check status sees untracked file
    const statusRes = await gitTool.handler({ subcommand: "status", args: ["--short"] }, env.ctx);
    assert.equal(statusRes.ok, true);
    assert.match(statusRes.data.output, /file\.txt/);

    // git_write add
    const addRes = await gitWriteTool.handler(
      { subcommand: "add", args: ["file.txt"] },
      env.ctx
    );
    assert.equal(addRes.ok, true);

    // git_write commit
    const commitRes = await gitWriteTool.handler(
      { subcommand: "commit", args: ["-m", "feat: initial commit"] },
      env.ctx
    );
    assert.equal(commitRes.ok, true);

    // git log verifies commit
    const logRes = await gitTool.handler(
      { subcommand: "log", args: ["-n", "1", "--oneline"] },
      env.ctx
    );
    assert.equal(logRes.ok, true);
    assert.match(logRes.data.output, /feat: initial commit/);
  });

  await t.test("git read tool rejects forbidden args", async () => {
    const res = await gitTool.handler(
      { subcommand: "log", args: ["--output=/tmp/evil.txt"] },
      env.ctx
    );
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /is not allowed in read-only git tool/);
  });
});
