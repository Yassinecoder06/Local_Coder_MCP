import test, { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createMcpServer } from "../src/mcp/server.js";
import { createWorkspace } from "../src/core/workspace.js";
import type { ToolContext } from "../src/core/types.js";
import { createMemoryActivityLog } from "../src/core/activity.js";
import { createSkillRegistry } from "../src/skills/index.js";
import { createCommandRegistry } from "../src/commands/index.js";
import { initSettings, updateSettings } from "../src/core/settings.js";
import type { AppConfig } from "../src/config.js";

describe("ToolContext callTool and callableTools wiring", () => {
  let tmpDir: string;
  let mockCtx: ToolContext;
  let activityLog: ReturnType<typeof createMemoryActivityLog>;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "calltool-test-"));
    const config: AppConfig = {
      port: 8787,
      hostPort: 8787,
      adminPort: 8788,
      host: "127.0.0.1",
      adminHost: "127.0.0.1",
      mcpToken: "test-token",
      publicUrl: "",
      tunnelMetricsUrl: "",
      authMode: "both",
      workspaceRoots: [tmpDir],
      defaultWorkspace: tmpDir,
      dataDir: tmpDir,
      builtinSkillsDir: path.join(tmpDir, "skills"),
      userSkillsDir: path.join(tmpDir, "user_skills"),
      extraSkillsDirs: [],
      builtinCommandsDir: path.join(tmpDir, "commands"),
      userCommandsDir: path.join(tmpDir, "user_commands"),
      approvalMode: "minimal",
      toolProfile: "essential",
      shellTimeoutMs: 10000,
      shellSyncMs: 5000,
      maxOutputBytes: 60000,
      checkpoints: true,
      logLevel: "info",
      version: "1.0.0",
    };

    initSettings(tmpDir, {
      disabledTools: [],
      toolProfile: "essential",
      approvalMode: "minimal",
    });

    const workspace = createWorkspace([tmpDir], tmpDir);
    activityLog = createMemoryActivityLog();
    const skills = createSkillRegistry(config, {
      get: () => ({ disabledTools: [], disabledSkills: [] }),
      update: async () => ({ disabledTools: [], disabledSkills: [] }),
    });
    const commands = createCommandRegistry(config);

    mockCtx = {
      config,
      workspace,
      activity: activityLog,
      skills,
      commands,
    };

    // Initialize MCP server instance which wires callTool & callableTools onto mockCtx
    await createMcpServer(mockCtx, "sess-12345678", () => ({
      userAgent: "Claude-Code/1.0",
      origin: "https://example.com",
    }));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("attaches callTool and callableTools to ctx", () => {
    assert.equal(typeof mockCtx.callTool, "function");
    assert.equal(typeof mockCtx.callableTools, "function");
  });

  it("refuses unknown tool and records activity with via: 'exec'", async () => {
    const res = await mockCtx.callTool!("nonexistent_tool_xyz", { someArg: "val" });
    assert.equal(res.ok, false);
    assert.ok(res.error?.includes("Unknown tool"));

    const recent = activityLog.recent(1);
    assert.equal(recent.length, 1);
    assert.equal(recent[0].tool, "nonexistent_tool_xyz");
    assert.equal(recent[0].ok, false);
    assert.equal(recent[0].via, "exec");
    assert.equal(recent[0].session, "sess-123");
    assert.equal(recent[0].client, "claude-code");
  });

  it("refuses recursion on exec and records activity with via: 'exec'", async () => {
    const res = await mockCtx.callTool!("exec", { code: "console.log('hi')" });
    assert.equal(res.ok, false);
    assert.ok(res.error?.includes("Recursion refusal"));

    const recent = activityLog.recent(1);
    assert.equal(recent.length, 1);
    assert.equal(recent[0].tool, "exec");
    assert.equal(recent[0].ok, false);
    assert.equal(recent[0].via, "exec");
  });

  it("suggests edit_files for familiar edit aliases and closest tool names", async () => {
    const alias = await mockCtx.callTool!("apply_patch", {});
    assert.equal(alias.ok, false);
    assert.match(alias.error ?? "", /tools\.edit_files\(\{ ops: \[\.\.\.\] \}\)/);
    assert.match(alias.error ?? "", /op: "patch"/);
    const typo = await mockCtx.callTool!("workspce_info", {});
    assert.match(typo.error ?? "", /workspace_info/);
  });

  it("refuses disabled tool and records activity with via: 'exec'", async () => {
    await updateSettings({ disabledTools: ["status"] });
    try {
      const res = await mockCtx.callTool!("status", {});
      assert.equal(res.ok, false);
      assert.ok(res.error?.includes("disabled"));

      const recent = activityLog.recent(1);
      assert.equal(recent.length, 1);
      assert.equal(recent[0].tool, "status");
      assert.equal(recent[0].ok, false);
      assert.equal(recent[0].via, "exec");
    } finally {
      await updateSettings({ disabledTools: [] });
    }
  });

  it("validates arguments with tool zod schema and records activity with via: 'exec'", async () => {
    // workspace_switch requires { path: string }
    const res = await mockCtx.callTool!("workspace_switch", {} as any);
    assert.equal(res.ok, false);
    assert.ok(res.error?.includes("Invalid arguments"));

    const recent = activityLog.recent(1);
    assert.equal(recent.length, 1);
    assert.equal(recent[0].tool, "workspace_switch");
    assert.equal(recent[0].ok, false);
    assert.equal(recent[0].via, "exec");
  });

  it("successfully runs tool handler and records activity with via: 'exec'", async () => {
    const res = await mockCtx.callTool!("workspace_info", {});
    assert.equal(res.ok, true);
    assert.equal(typeof res.data, "object");

    const recent = activityLog.recent(1);
    assert.equal(recent.length, 1);
    assert.equal(recent[0].tool, "workspace_info");
    assert.equal(recent[0].ok, true);
    assert.equal(recent[0].via, "exec");
    assert.equal(recent[0].session, "sess-123");
    assert.equal(recent[0].client, "claude-code");
  });

  it("callableTools() returns enabled tools in profile and excludes exec and disabled tools", async () => {
    const toolsBefore = mockCtx.callableTools!();
    assert.ok(toolsBefore.length > 0);
    assert.ok(toolsBefore.some((t) => t.name === "workspace_info"));
    assert.ok(!toolsBefore.some((t) => t.name === "exec"), "callableTools must never include exec");

    // Disable a tool and check it's excluded
    await updateSettings({ disabledTools: ["workspace_info"] });
    try {
      const toolsAfter = mockCtx.callableTools!();
      assert.ok(!toolsAfter.some((t) => t.name === "workspace_info"));
    } finally {
      await updateSettings({ disabledTools: [] });
    }
  });
});
