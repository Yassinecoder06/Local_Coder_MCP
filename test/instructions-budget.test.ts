import test, { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildInstructions } from "../src/mcp/instructions.js";
import { createWorkspace } from "../src/core/workspace.js";
import type { ToolContext } from "../src/core/types.js";
import { createMemoryActivityLog } from "../src/core/activity.js";
import { createSkillRegistry } from "../src/skills/index.js";
import { createCommandRegistry } from "../src/commands/index.js";
import { loadConfig, type AppConfig } from "../src/config.js";

describe("Tool-Call Budget and Instructions Guidelines", () => {
  let tmpDir: string;
  let mockCtx: ToolContext;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "instructions-budget-test-"));
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

    const workspace = createWorkspace([tmpDir], tmpDir);
    const activity = createMemoryActivityLog();
    const skills = createSkillRegistry(config, {
      get: () => ({ disabledTools: [], disabledSkills: [] }),
      update: async () => ({ disabledTools: [], disabledSkills: [] }),
    });
    const commands = createCommandRegistry(config);

    mockCtx = {
      config,
      workspace,
      activity,
      skills,
      commands,
    };
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("includes Tool-call budget section with batching, scoping, and resume guidance", async () => {
    const instructions = await buildInstructions(mockCtx);

    assert.ok(instructions.includes("## Tool-call budget"), "Must include ## Tool-call budget section header");
    assert.ok(
      instructions.includes("the client may cap tool calls per reply"),
      "Must state tool calls may be capped"
    );
    assert.ok(
      instructions.includes("for 3+ related calls use `exec` (one JS program calling tools in parallel)"),
      "Must advise using exec for 3+ related calls"
    );
    assert.ok(
      instructions.includes("`run` accepts `cmds` (up to 20 commands, one shell)"),
      "Must advise that run accepts cmds"
    );
    assert.ok(
      instructions.includes("batch shell work into one `run` (chain with && / ;)"),
      "Must advise batching shell work"
    );
    assert.ok(
      instructions.includes("read many files in one `read` call"),
      "Must advise reading multiple files in one call"
    );
    assert.ok(
      instructions.includes(
        "skip exploration that is not needed (no env dumps, no inspecting binaries/wrapper scripts)"
      ),
      "Must advise skipping unnecessary exploration"
    );
    assert.ok(
      instructions.includes('call `resume` after "continue"'),
      "Must advise calling resume after continue"
    );
  });

  it("instructs to use browser_check and never launch raw chromium/chrome/playwright via run", async () => {
    const instructions = await buildInstructions(mockCtx);
    assert.ok(
      instructions.includes(
        'For browser/UI verification always use `browser_check` (screenshot, console errors); never launch chromium/chrome/playwright yourself via run.'
      ),
      "Must include browser_check rule against raw chromium launches"
    );
  });

  it("includes human-in-the-loop ask_user and finish instructions", async () => {
    const instructions = await buildInstructions(mockCtx);
    assert.ok(
      instructions.includes(
        "If a step needs the person (sudo, interactive login, secrets, hardware), use ask_user with the exact command, then user_request_status; never use it to get around something you declined."
      ),
      "Must include ask_user guidance"
    );
    assert.ok(
      instructions.includes(
        "When done, call finish with a summary; it checks your evidence (verify/browser_check). Run checks first."
      ),
      "Must include finish guidance"
    );
  });

  it("includes herdr prompt and pane safety rules when herdr is available", async () => {
    const origPath = process.env.PATH;
    const binDir = path.join(tmpDir, "mock-herdr-bin");
    fs.mkdirSync(binDir, { recursive: true });
    const mockHerdr = path.join(binDir, "herdr");
    fs.writeFileSync(mockHerdr, "#!/bin/sh\necho 'client: active'\nexit 0\n", { mode: 0o755 });

    try {
      process.env.PATH = `${binDir}:${origPath}`;
      const instructions = await buildInstructions(mockCtx);

      assert.ok(
        instructions.includes(
          'use `herdr agent list` + `herdr agent prompt <pane> "<task>" --wait` then `herdr agent read`'
        ),
        "Must specify herdr agent prompt/read flow"
      );
      assert.ok(
        instructions.includes("never `pane run` into panes running an agent unless the user asks"),
        "Must warn against typing into agent panes"
      );
      assert.ok(
        instructions.includes("never stop/restart agents unless asked"),
        "Must warn against stopping/restarting agents unasked"
      );
    } finally {
      process.env.PATH = origPath;
    }
  });

  it("keeps total base instructions size under 4 KB", async () => {
    const origPath = process.env.PATH;
    const binDir = path.join(tmpDir, "mock-herdr-bin-size");
    fs.mkdirSync(binDir, { recursive: true });
    const mockHerdr = path.join(binDir, "herdr");
    fs.writeFileSync(mockHerdr, "#!/bin/sh\necho 'client: active'\nexit 0\n", { mode: 0o755 });

    try {
      process.env.PATH = `${binDir}:${origPath}`;
      const instructions = await buildInstructions(mockCtx);
      const byteLength = Buffer.byteLength(instructions, "utf-8");
      assert.ok(
        byteLength < 4096,
        `Instructions must be under 4096 bytes (actual: ${byteLength} bytes)`
      );
    } finally {
      process.env.PATH = origPath;
    }
  });

  it("parses CLIENT_CALL_BUDGET_MS from simple string or JSON map", () => {
    // Default
    const defaultConfig = loadConfig({} as any);
    assert.deepEqual(defaultConfig.clientCallBudgetsMs, { gemini: 8000 });

    // Simple string
    const simpleConfig = loadConfig({ CLIENT_CALL_BUDGET_MS: "gemini=7000;chatgpt=12000" } as any);
    assert.deepEqual(simpleConfig.clientCallBudgetsMs, { gemini: 7000, chatgpt: 12000 });

    // JSON map
    const jsonConfig = loadConfig({ CLIENT_CALL_BUDGET_MS: '{"gemini": 6000, "claude": 15000}' } as any);
    assert.deepEqual(jsonConfig.clientCallBudgetsMs, { gemini: 6000, claude: 15000 });
  });
});
