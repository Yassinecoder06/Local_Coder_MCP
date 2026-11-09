import test, { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPluginHub } from "../src/plugins/hub.js";
import { createMcpServer } from "../src/mcp/server.js";
import { createMemoryActivityLog } from "../src/core/activity.js";
import { createWorkspace } from "../src/core/workspace.js";
import { createSkillRegistry } from "../src/skills/index.js";
import { createCommandRegistry } from "../src/commands/index.js";
import { initSettings } from "../src/core/settings.js";
import type { AppConfig } from "../src/config.js";
import type { ToolContext } from "../src/core/types.js";

const FIXTURE_ECHO = fileURLToPath(new URL("./fixtures/echo-mcp.mjs", import.meta.url));
const FIXTURE_RICH = fileURLToPath(new URL("./fixtures/rich-mcp.mjs", import.meta.url));

describe("Plugin Hub execTools & MCP Server PluginBridge", () => {
  let tmpDir: string;
  let config: AppConfig;
  let hub: ReturnType<typeof createPluginHub>;
  let activity: ReturnType<typeof createMemoryActivityLog>;
  let ctx: ToolContext;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugins-bridge-test-"));
    config = {
      port: 8787,
      hostPort: 8787,
      adminPort: 8788,
      host: "127.0.0.1",
      adminHost: "127.0.0.1",
      mcpToken: "test-bridge-token",
      publicUrl: "",
      tunnelMetricsUrl: "",
      authMode: "token",
      workspaceRoots: [tmpDir],
      defaultWorkspace: tmpDir,
      dataDir: tmpDir,
      builtinSkillsDir: path.join(tmpDir, "skills"),
      userSkillsDir: path.join(tmpDir, "user_skills"),
      extraSkillsDirs: [],
      builtinCommandsDir: path.join(tmpDir, "commands"),
      userCommandsDir: path.join(tmpDir, "user_commands"),
      approvalMode: "standard",
      toolProfile: "essential",
      shellTimeoutMs: 10000,
      shellSyncMs: 5000,
      maxOutputBytes: 60000,
      checkpoints: true,
      logLevel: "info",
      version: "1.0.0",
    };

    initSettings(tmpDir, { approvalMode: "standard", toolProfile: "essential" });
    activity = createMemoryActivityLog();
    const skills = createSkillRegistry(config, {
      get: () => ({ disabledTools: [], disabledSkills: [] }),
      update: async () => ({ disabledTools: [], disabledSkills: [] }),
    });
    const commands = createCommandRegistry(config);
    const workspace = createWorkspace([tmpDir], tmpDir);

    ctx = {
      config,
      workspace,
      skills,
      commands,
      activity,
    };

    hub = createPluginHub(config);
    await hub.start();

    // Add echo plugin (untrusted initially)
    await hub.add({
      id: "echo-plugin",
      name: "Echo Plugin",
      transport: {
        type: "stdio",
        command: "node",
        args: [FIXTURE_ECHO],
      },
    });

    // Add rich plugin (untrusted initially)
    await hub.add({
      id: "rich-plugin",
      name: "Rich Plugin",
      transport: {
        type: "stdio",
        command: "node",
        args: [FIXTURE_RICH],
      },
    });
  });

  after(async () => {
    await hub.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("computes execAllowed correctly for readOnly vs non-readOnly in untrusted plugin", async () => {
    const execTools = hub.execTools();
    const addTool = execTools.find((t) => t.plugin === "echo-plugin" && t.name === "add");
    const echoTool = execTools.find((t) => t.plugin === "echo-plugin" && t.name === "echo");

    assert.ok(addTool);
    assert.ok(echoTool);

    // 'add' has upstream readOnlyHint: true -> execAllowed is true
    assert.equal(addTool.execAllowed, true);

    // 'echo' has no readOnlyHint on untrusted plugin -> execAllowed is false
    assert.equal(echoTool.execAllowed, false);
  });

  it("computes execAllowed as true for all tools when plugin is trusted", async () => {
    let changeFired = false;
    const unsub = hub.subscribe(() => {
      changeFired = true;
    });

    // Trust echo-plugin
    await hub.update("echo-plugin", { trusted: true });
    assert.ok(changeFired, "subscribe must fire when trusted changes");

    const execTools = hub.execTools();
    const echoTool = execTools.find((t) => t.plugin === "echo-plugin" && t.name === "echo");
    assert.ok(echoTool);
    assert.equal(echoTool.execAllowed, true);

    // Revert to untrusted
    await hub.update("echo-plugin", { trusted: false });
    unsub();
  });

  it("excludes disabled tool from execTools and marks execAllowed false in detail", async () => {
    await hub.setToolEnabled("echo-plugin", "add", false);

    const execTools = hub.execTools();
    const addExec = execTools.find((t) => t.plugin === "echo-plugin" && t.name === "add");
    assert.equal(addExec, undefined, "Disabled tool must not be in execTools");

    const detail = hub.get("echo-plugin");
    const addDetail = detail?.tools.find((t) => t.name === "add");
    assert.ok(addDetail);
    assert.equal(addDetail.enabled, false);
    assert.equal(addDetail.execAllowed, false);

    // Re-enable 'add'
    await hub.setToolEnabled("echo-plugin", "add", true);
  });

  it("wires ctx.plugins via createMcpServer when hub exists", async () => {
    assert.equal(ctx.plugins, undefined);

    await createMcpServer(
      ctx,
      "session-test-1234",
      () => ({ userAgent: "test-client", origin: "" }),
      hub
    );

    assert.ok(ctx.plugins, "ctx.plugins must be wired");
    const list = ctx.plugins.list();
    assert.ok(list.length >= 4);
    assert.ok(list.some((t) => t.plugin === "echo-plugin" && t.name === "add"));
  });

  it("bridge refuses call to tool when execAllowed is false, returning ok:false without throwing", async () => {
    // echo is untrusted and not read-only
    const res = await ctx.plugins!.call("echo-plugin", "echo", { message: "secret" });

    assert.equal(res.ok, false);
    assert.match(res.summary, /not allowed in exec/);
    assert.match(res.error || "", /not allowed in exec/);

    // Verify activity logged
    const recent = activity.recent(5);
    const entry = recent.find((e) => e.tool === "echo-plugin.echo");
    assert.ok(entry);
    assert.equal(entry.ok, false);
    assert.equal(entry.via, "exec");
    assert.equal(entry.workspace, ctx.workspace.active());
  });

  it("bridge allows call to read-only tool, accepting '_' for '-' in plugin id", async () => {
    // 'add' is read-only; using 'echo_plugin' instead of 'echo-plugin'
    const res = await ctx.plugins!.call("echo_plugin", "add", { a: 15, b: 27 });

    assert.equal(res.ok, true);
    assert.equal(res.tool, "echo-plugin.add");
    assert.equal(res.data?.text, "42");
    assert.equal(res.summary, "42");

    // Verify activity entry
    const recent = activity.recent(5);
    const entry = recent.find((e) => e.tool === "echo-plugin.add");
    assert.ok(entry);
    assert.equal(entry.ok, true);
    assert.equal(entry.via, "exec");
  });

  it("bridge handles result conversion for text, image, structuredContent, and isError", async () => {
    // 1. Tool returning text + image + structuredContent
    const richRes = await ctx.plugins!.call("rich-plugin", "produce_rich", { tag: "alpha" });
    assert.equal(richRes.ok, true);
    assert.equal(richRes.summary, "result for alpha");
    assert.equal(richRes.data?.text, "result for alpha");
    assert.deepEqual(richRes.data?.structured, { status: "complete", score: 99 });
    assert.ok(Array.isArray(richRes.images));
    assert.equal(richRes.images.length, 1);
    assert.equal(richRes.images[0].mimeType, "image/png");
    assert.ok(richRes.images[0].data.length > 20);

    // 2. Tool returning isError: true
    const errRes = await ctx.plugins!.call("rich-plugin", "produce_error", {});
    assert.equal(errRes.ok, false);
    assert.equal(errRes.summary, "Operation failed upstream");
    assert.equal(errRes.error, "Operation failed upstream");
    assert.equal(errRes.data?.text, "Operation failed upstream");
  });

  it("bridge refuses call to unknown plugin or unknown tool without throwing", async () => {
    const res1 = await ctx.plugins!.call("nonexistent-plugin", "add", {});
    assert.equal(res1.ok, false);
    assert.match(res1.summary, /not available or not ready/);

    const res2 = await ctx.plugins!.call("echo-plugin", "nonexistent-tool", {});
    assert.equal(res2.ok, false);
    assert.match(res2.summary, /not available or not ready/);
  });
});
