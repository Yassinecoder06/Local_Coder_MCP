import test, { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { detectIntegrations, detectHerdr, detectBrowser } from "../src/core/integrations.js";
import { buildInstructions } from "../src/mcp/instructions.js";
import { browserCheckTool, getChromiumPath, trimChromiumError } from "../src/tools/browser.js";
import { createWorkspace } from "../src/core/workspace.js";
import { toCallToolResult } from "../src/core/result.js";
import type { ToolContext } from "../src/core/types.js";
import { createMemoryActivityLog } from "../src/core/activity.js";
import { createSkillRegistry } from "../src/skills/index.js";
import { createCommandRegistry } from "../src/commands/index.js";
import type { AppConfig } from "../src/config.js";

describe("Integrations & Browser Check", () => {
  let tmpDir: string;
  let mockCtx: ToolContext;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-test-"));
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
    const skills = createSkillRegistry(config, { get: () => ({ disabledTools: [], disabledSkills: [] }), update: async () => ({ disabledTools: [], disabledSkills: [] }) });
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
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  describe("Integration Detection", () => {
    it("detectBrowser reports missing Chromium with install hint", () => {
      const origChromium = process.env.CHROMIUM_PATH;
      try {
        process.env.CHROMIUM_PATH = "/tmp/non-existent-chromium-bin-999";
        const res = detectBrowser();
        assert.equal(res.available, false);
        assert.ok(res.detail.includes("Chromium not found"));
      } finally {
        if (origChromium !== undefined) {
          process.env.CHROMIUM_PATH = origChromium;
        } else {
          delete process.env.CHROMIUM_PATH;
        }
      }
    });

    it("detectBrowser reports available when executable exists", () => {
      const origChromium = process.env.CHROMIUM_PATH;
      const fakeChromium = path.join(tmpDir, "fake-chromium");
      fs.writeFileSync(fakeChromium, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      try {
        process.env.CHROMIUM_PATH = fakeChromium;
        const res = detectBrowser();
        assert.equal(res.available, true);
        assert.equal(res.detail, fakeChromium);
      } finally {
        if (origChromium !== undefined) {
          process.env.CHROMIUM_PATH = origChromium;
        } else {
          delete process.env.CHROMIUM_PATH;
        }
      }
    });

    it("detectHerdr reports not available when binary is missing from PATH", async () => {
      const origPath = process.env.PATH;
      try {
        // Mock empty PATH
        process.env.PATH = "/tmp/empty-path-mock-dir-xyz";
        const res = await detectHerdr(1000);
        assert.equal(res.available, false);
        assert.ok(res.detail.includes("not found on PATH"));
      } finally {
        process.env.PATH = origPath;
      }
    });

    it("detectHerdr reports available when mock herdr binary exits 0", async () => {
      const origPath = process.env.PATH;
      const binDir = path.join(tmpDir, "mock-bin");
      fs.mkdirSync(binDir, { recursive: true });
      const mockHerdr = path.join(binDir, "herdr");
      fs.writeFileSync(mockHerdr, "#!/bin/sh\necho 'client: version 0.9.5'\nexit 0\n", { mode: 0o755 });

      try {
        process.env.PATH = `${binDir}:${origPath}`;
        const res = await detectHerdr(1000);
        assert.equal(res.available, true);
        assert.ok(res.detail.includes("herdr is active"));
        assert.ok(res.detail.includes("version 0.9.5"));
      } finally {
        process.env.PATH = origPath;
      }
    });

    it("detectIntegrations returns both herdr and browser statuses", async () => {
      const res = await detectIntegrations();
      assert.ok("herdr" in res);
      assert.ok("browser" in res);
      assert.equal(typeof res.herdr.available, "boolean");
      assert.equal(typeof res.browser.available, "boolean");
    });
  });

  describe("Server Instructions Content", () => {
    it("includes 'Work like an agent' section and keeps total size under 4 KB", async () => {
      const instructions = await buildInstructions(mockCtx);

      assert.ok(instructions.includes("## Work like an agent"));
      assert.ok(instructions.includes("plan multi-step work with todo"));
      assert.ok(instructions.includes("after every change read diagnostics from edit_files"));
      assert.ok(instructions.includes("run run{verify:true} before claiming done"));
      assert.ok(instructions.includes("for UI or web work, use browser_check and look at the screenshot"));
      assert.ok(instructions.includes("on 'continue', call resume first"));
      assert.ok(instructions.includes("never say it works without evidence from a check"));

      // Check instructions size < 4 KB
      const bytes = Buffer.byteLength(instructions, "utf-8");
      assert.ok(bytes < 4096, `Instructions should be under 4096 bytes (got ${bytes} bytes)`);
    });

    it("adds herdr guidance to instructions when herdr is available", async () => {
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
            "herdr is available: skill_load herdr to drive host terminals and CLI agents (agy, codex) for long or parallel work."
          )
        );
      } finally {
        process.env.PATH = origPath;
      }
    });
  });

  describe("Browser Check Tool", () => {
    it("gracefully returns ok:false with install hint when Chromium is missing", async () => {
      const origChromium = process.env.CHROMIUM_PATH;
      try {
        process.env.CHROMIUM_PATH = "/tmp/non-existent-chromium-for-tool-test";
        const res = await browserCheckTool.handler({ url: "http://localhost:1234" }, mockCtx);
        assert.equal(res.ok, false);
        assert.ok(res.error?.includes("Chromium executable not found"));
        assert.ok(res.error?.includes("Install chromium"));
      } finally {
        if (origChromium !== undefined) {
          process.env.CHROMIUM_PATH = origChromium;
        } else {
          delete process.env.CHROMIUM_PATH;
        }
      }
    });

    it("validates that either url or path is provided", async () => {
      const res = await browserCheckTool.handler({}, mockCtx);
      assert.equal(res.ok, false);
      assert.ok(res.error?.includes("Either 'url' or 'path' must be provided"));
    });

    it("loads local HTML file with static server, executes actions, and returns screenshot image block", async () => {
      // Find viable chromium or google-chrome for the test, or skip if neither exists
      let executable = process.env.CHROMIUM_PATH;
      if (!executable || !fs.existsSync(executable)) {
        if (fs.existsSync("/usr/bin/chromium")) executable = "/usr/bin/chromium";
        else if (fs.existsSync("/usr/bin/google-chrome")) executable = "/usr/bin/google-chrome";
      }

      if (!executable || !fs.existsSync(executable)) {
        console.log("Skipping live browser check: No Chromium executable found on host.");
        return;
      }

      const origChromium = process.env.CHROMIUM_PATH;
      process.env.CHROMIUM_PATH = executable;

      try {
        const htmlFile = path.join(tmpDir, "test.html");
        fs.writeFileSync(
          htmlFile,
          `<!DOCTYPE html>
<html>
<head><title>Browser Check Test</title></head>
<body>
  <h1>Header</h1>
  <button id="test-btn" onclick="document.body.innerHTML += '<p id=\\'result\\'>Action Executed</p>'">Click</button>
  <script>
    console.log("sample console message");
  </script>
</body>
</html>`,
          "utf-8"
        );

        const res = await browserCheckTool.handler(
          {
            path: "test.html",
            wait_ms: 300,
            viewport: "desktop",
            actions: [{ type: "click", selector: "#test-btn" }],
            full_page: false,
          },
          mockCtx
        );

        assert.equal(res.ok, true);
        assert.equal(res.data?.title, "Browser Check Test");
        assert.ok(res.summary.includes("with 0 errors"));
        assert.ok(res.data?.console?.some((c: any) => c.text === "sample console message"));
        assert.equal(res.data?.pageErrors?.length, 0);
        assert.equal(res.data?.failedRequests?.length, 0);

        // Verify images returned in ToolResult
        assert.ok(res.images && res.images.length === 1);
        assert.equal(res.images[0].mimeType, "image/png");
        assert.ok(res.images[0].data.length > 100);

        // Verify toCallToolResult creates proper MCP image block
        const callToolResult = toCallToolResult(res, 60000);
        assert.equal(callToolResult.isError, false);
        assert.equal(callToolResult.content[0].type, "text");
        assert.equal(callToolResult.content[1].type, "image");
        assert.equal((callToolResult.content[1] as any).mimeType, "image/png");
      } finally {
        if (origChromium !== undefined) {
          process.env.CHROMIUM_PATH = origChromium;
        } else {
          delete process.env.CHROMIUM_PATH;
        }
      }
    });

    it("trimChromiumError removes giant <launching> args line and extracts meaningful error", () => {
      const rawPlaywrightError = `browserType.launch: Headless Chromium crashed in this environment.
=========================== logs ===========================
<launching> /usr/bin/chromium --disable-field-trial-config --disable-background-networking --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-back-forward-cache --disable-breakpad --disable-client-side-phishing-detection --no-sandbox
<launched> pid=29103
[pid=29103][err] [29103:29103:1109/120000.123:ERROR:file_util_posix.cc(695)] Couldn't create a temp dir in /root/.config/chromium.
<process did exit: exitCode=1, signal=null>
============================================================`;

      const trimmed = trimChromiumError(rawPlaywrightError);
      assert.ok(!trimmed.includes("<launching>"));
      assert.ok(!trimmed.includes("--disable-field-trial-config"));
      assert.ok(trimmed.includes("Couldn't create a temp dir in /root/.config/chromium."));
      assert.ok(trimmed.includes("Headless Chromium crashed in this environment"));

      // Call log format
      const callLogError = `browserType.launch: Process crashed
Call log:
  - <launching> /usr/bin/chromium --args-xyz
  - [pid=555] [err] Inconsistency detected by ld.so: dl-tls.c: 100: unexpected tls error
  - [pid=555] <process did exit: exitCode=127, signal=null>`;

      const callLogTrimmed = trimChromiumError(callLogError);
      assert.ok(!callLogTrimmed.includes("<launching>"));
      assert.ok(!callLogTrimmed.includes("Call log:"));
      assert.ok(callLogTrimmed.includes("Inconsistency detected by ld.so"));

      // Error with only exit code
      const exitOnly = `browserType.launch: Headless Chromium crashed in this environment.
<launching> /usr/bin/chromium --args
<process did exit: exitCode=139, signal=SIGSEGV>`;
      const exitTrimmed = trimChromiumError(exitOnly);
      assert.ok(!exitTrimmed.includes("<launching>"));
      assert.ok(exitTrimmed.includes("Headless Chromium crashed in this environment"));
      assert.ok(exitTrimmed.includes("<process did exit: exitCode=139, signal=SIGSEGV>"));

      // Non-launch error remains untouched
      const simple = "browser_check timed out after 30s";
      assert.equal(trimChromiumError(simple), simple);
      assert.equal(trimChromiumError(new Error(simple)), simple);
    });
  });
});
