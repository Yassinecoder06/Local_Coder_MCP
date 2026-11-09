import test from "node:test";
import assert from "node:assert/strict";
import { execTool } from "../src/tools/exec.js";
import { createTestEnvironment } from "./helpers.js";
import type { ToolResult } from "../src/core/types.js";

test("exec tool: code-mode isolated execution", async (t) => {
  const env = await createTestEnvironment();

  t.after(async () => {
    await env.cleanup();
  });

  await t.test("fails gracefully when ctx.callTool is undefined", async () => {
    const ctxWithoutCallTool = { ...env.ctx, callTool: undefined };
    const res = await execTool.handler({ code: "text('hello')" }, ctxWithoutCallTool);
    assert.equal(res.ok, false);
    assert.match(res.error || "", /callTool is not configured/);
  });

  await t.test("happy path: sequential tool calls and text output", async () => {
    const recordedCalls: Array<{ name: string; args: any }> = [];
    const mockCtx = {
      ...env.ctx,
      callTool: async (name: string, args: Record<string, unknown>): Promise<ToolResult> => {
        recordedCalls.push({ name, args });
        return {
          ok: true,
          tool: name,
          summary: `Summary of ${name}`,
          data: { sample: `data for ${name}` },
        };
      },
      callableTools: () => [
        { name: "read", description: "Read files" },
        { name: "git", description: "Git operations" },
      ],
    };

    const code = `
      const r = await tools.read({ paths: ["package.json"] });
      text(r.summary);
      text({ result: r.data });
    `;

    const res = await execTool.handler({ code }, mockCtx);
    assert.equal(res.ok, true);
    assert.equal(recordedCalls.length, 1);
    assert.equal(recordedCalls[0].name, "read");
    assert.deepEqual(recordedCalls[0].args, { paths: ["package.json"] });
    assert.equal(res.data?.tool_calls_count, 1);
    assert.match(res.summary, /1 tool call/);
    assert.match(res.data?.text, /Summary of read/);
    assert.match(res.data?.text, /"sample": "data for read"/);
  });

  await t.test("parallel calls via Promise.all", async () => {
    const mockCtx = {
      ...env.ctx,
      callTool: async (name: string, args: Record<string, unknown>): Promise<ToolResult> => {
        return {
          ok: true,
          tool: name,
          summary: `Summary: ${name}`,
          data: args,
        };
      },
    };

    const code = `
      const [a, b] = await Promise.all([
        tools.read({ paths: ["file1.txt"] }),
        tools.git({ subcommand: "status" })
      ]);
      text(\`a: \${a.summary}, b: \${b.summary}\`);
    `;

    const res = await execTool.handler({ code }, mockCtx);
    assert.equal(res.ok, true);
    assert.equal(res.data?.tool_calls_count, 2);
    assert.match(res.data?.text, /a: Summary: read, b: Summary: git/);
  });

  await t.test("enforces tool call limit (max 32 calls)", async () => {
    let callCount = 0;
    const mockCtx = {
      ...env.ctx,
      callTool: async (name: string): Promise<ToolResult> => {
        callCount++;
        return { ok: true, tool: name, summary: "ok" };
      },
    };

    const code = `
      for (let i = 0; i < 35; i++) {
        await tools.status({});
      }
    `;

    const res = await execTool.handler({ code }, mockCtx);
    assert.equal(res.ok, false);
    assert.match(res.error || "", /Exceeded maximum limit of 32 tool calls/);
  });

  await t.test("enforces timeout with override", async () => {
    const mockCtx = {
      ...env.ctx,
      callTool: async (name: string): Promise<ToolResult> => {
        // Sleep 100ms per call
        await new Promise((r) => setTimeout(r, 100));
        return { ok: true, tool: name, summary: "ok" };
      },
    };

    const code = `
      while (true) {
        await tools.status({});
      }
    `;

    // 150ms timeout override
    const res = await execTool.handler({ code, timeout_ms: 150 }, mockCtx);
    assert.equal(res.ok, false);
    assert.match(res.error || "", /timed out after 150ms/);
  });

  await t.test("reports syntax errors with line number", async () => {
    const mockCtx = {
      ...env.ctx,
      callTool: async () => ({ ok: true, tool: "test", summary: "ok" }),
    };

    const code = "const a = 1;\nconst b = ;\nconst c = 3;";
    const res = await execTool.handler({ code }, mockCtx);
    assert.equal(res.ok, false);
    assert.match(res.error || "", /line 2/);
  });

  await t.test("blocks ambient globals (require, process, fetch, timers)", async () => {
    const mockCtx = {
      ...env.ctx,
      callTool: async () => ({ ok: true, tool: "test", summary: "ok" }),
    };

    // require
    const reqRes = await execTool.handler({ code: "require('node:fs')" }, mockCtx);
    assert.equal(reqRes.ok, false);
    assert.match(reqRes.error || "", /require is (not defined|not a function)/);

    // process
    const procRes = await execTool.handler({ code: "process.exit(1)" }, mockCtx);
    assert.equal(procRes.ok, false);
    assert.match(procRes.error || "", /(process is not defined|Cannot read properties of undefined)/);

    // setTimeout
    const timerRes = await execTool.handler({ code: "setTimeout(() => {}, 100)" }, mockCtx);
    assert.equal(timerRes.ok, false);
    assert.match(timerRes.error || "", /setTimeout is (not defined|not a function)/);
  });

  await t.test("captures images and attaches them to ToolResult.images", async () => {
    const mockCtx = {
      ...env.ctx,
      callTool: async (): Promise<ToolResult> => ({
        ok: true,
        tool: "browser_check",
        summary: "Screenshot taken",
        images: [{ data: "base64image1", mimeType: "image/png" }],
      }),
    };

    const code = `
      const res = await tools.browser_check({ url: "http://localhost:3000" });
      image(res);
      image({ data: "base64image2", mimeType: "image/jpeg" });
    `;

    const res = await execTool.handler({ code }, mockCtx);
    assert.equal(res.ok, true);
    assert.ok(res.images && res.images.length === 2);
    assert.equal(res.images[0].data, "base64image1");
    assert.equal(res.images[0].mimeType, "image/png");
    assert.equal(res.images[1].data, "base64image2");
    assert.equal(res.images[1].mimeType, "image/jpeg");
  });

  await t.test("rejects recursive exec calls", async () => {
    const mockCtx = {
      ...env.ctx,
      callTool: async () => ({ ok: true, tool: "test", summary: "ok" }),
    };

    const code = "await tools.exec({ code: 'text(1)' });";
    const res = await execTool.handler({ code }, mockCtx);
    assert.equal(res.ok, false);
    assert.match(res.error || "", /Recursive exec call is not allowed/);
  });

  await t.test("queues more than 8 parallel calls instead of failing", async () => {
    let active = 0, peak = 0;
    const mockCtx = {
      ...env.ctx,
      callTool: async (name: string): Promise<ToolResult> => {
        active++; peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 20));
        active--;
        return { ok: true, tool: name, summary: "ok" };
      },
      callableTools: () => [{ name: "read", description: "Read files" }],
    };
    const code = `const rs = await Promise.all(Array.from({ length: 12 }, () => tools.read({ paths: ["a"] }))); text(String(rs.length));`;
    const res = await execTool.handler({ code }, mockCtx);
    assert.equal(res.ok, true, res.error);
    assert.match(JSON.stringify(res.data ?? res.summary), /12/);
    assert.ok(peak <= 8, `peak concurrency ${peak}`);
  });

  await t.test("plugins proxy routes calls to ctx.plugins.call", async () => {
    const pluginCalls: Array<{ plugin: string; tool: string; args: any }> = [];
    const mockCtx = {
      ...env.ctx,
      callTool: async () => ({ ok: true, tool: "test", summary: "ok" }),
      plugins: {
        list: () => [
          {
            plugin: "test-plugin",
            name: "ping",
            description: "Ping tool",
            inputSchema: {},
            enabled: true,
            published: true,
            execAllowed: true,
          },
        ],
        call: async (plugin: string, tool: string, args: Record<string, unknown>): Promise<ToolResult> => {
          pluginCalls.push({ plugin, tool, args });
          return { ok: true, tool: `${plugin}.${tool}`, summary: "pong", data: { echo: args } };
        },
      },
    };

    const code = `
      const res = await plugins.test_plugin.ping({ message: "hello" });
      text(res.summary);
      text({ PLUGINS });
    `;

    const res = await execTool.handler({ code }, mockCtx);
    assert.equal(res.ok, true, res.error);
    assert.equal(pluginCalls.length, 1);
    assert.equal(pluginCalls[0].plugin, "test-plugin");
    assert.equal(pluginCalls[0].tool, "ping");
    assert.deepEqual(pluginCalls[0].args, { message: "hello" });
    assert.match(res.data?.text, /pong/);
    assert.match(res.data?.text, /"plugin": "test-plugin"/);
    assert.match(res.data?.text, /"tool": "ping"/);
  });

  await t.test("plugins proxy handles _ and - interchangeably in plugin ids", async () => {
    const recordedPlugins: string[] = [];
    const mockCtx = {
      ...env.ctx,
      callTool: async () => ({ ok: true, tool: "test", summary: "ok" }),
      plugins: {
        list: () => [
          {
            plugin: "chrome-devtools",
            name: "eval",
            description: "Eval in browser",
            inputSchema: {},
            enabled: true,
            published: true,
            execAllowed: true,
          },
        ],
        call: async (plugin: string, tool: string, args: Record<string, unknown>): Promise<ToolResult> => {
          recordedPlugins.push(plugin);
          return { ok: true, tool: `${plugin}.${tool}`, summary: "ok" };
        },
      },
    };

    const code = `
      await plugins.chrome_devtools.eval({ code: "1" });
      await plugins["chrome-devtools"].eval({ code: "2" });
    `;

    const res = await execTool.handler({ code }, mockCtx);
    assert.equal(res.ok, true, res.error);
    assert.equal(recordedPlugins.length, 2);
    assert.equal(recordedPlugins[0], "chrome-devtools");
    assert.equal(recordedPlugins[1], "chrome-devtools");
  });

  await t.test("shares tool call limit between tools and plugins", async () => {
    let calls = 0;
    const mockCtx = {
      ...env.ctx,
      callTool: async (name: string): Promise<ToolResult> => {
        calls++;
        return { ok: true, tool: name, summary: "ok" };
      },
      plugins: {
        list: () => [
          {
            plugin: "test-plugin",
            name: "ping",
            description: "Ping tool",
            inputSchema: {},
            enabled: true,
            published: true,
            execAllowed: true,
          },
        ],
        call: async (): Promise<ToolResult> => {
          calls++;
          return { ok: true, tool: "test", summary: "ok" };
        },
      },
    };

    const code = `
      for (let i = 0; i < 20; i++) {
        await tools.status({});
      }
      for (let i = 0; i < 15; i++) {
        await plugins.test_plugin.ping({});
      }
    `;

    const res = await execTool.handler({ code }, mockCtx);
    assert.equal(res.ok, false);
    assert.match(res.error || "", /Exceeded maximum limit of 32 tool calls in exec/);
  });

  await t.test("rejects with clear message when ctx.plugins is undefined", async () => {
    const mockCtx = {
      ...env.ctx,
      callTool: async () => ({ ok: true, tool: "test", summary: "ok" }),
      plugins: undefined,
    };

    const code = `await plugins.chrome_devtools.eval({ code: "1" });`;
    const res = await execTool.handler({ code }, mockCtx);
    assert.equal(res.ok, false);
    assert.match(res.error || "", /No plugins are configured\. Add one in Admin → Plugins\./);
  });

  await t.test("image(res) captures images returned by plugin bridge", async () => {
    const mockCtx = {
      ...env.ctx,
      callTool: async () => ({ ok: true, tool: "test", summary: "ok" }),
      plugins: {
        list: () => [
          {
            plugin: "screenshot-plugin",
            name: "snap",
            description: "Take snapshot",
            inputSchema: {},
            enabled: true,
            published: true,
            execAllowed: true,
          },
        ],
        call: async (): Promise<ToolResult> => {
          return {
            ok: true,
            tool: "screenshot-plugin.snap",
            summary: "Snap captured",
            images: [{ data: "pluginBase64Image", mimeType: "image/png" }],
          };
        },
      },
    };

    const code = `
      const res = await plugins.screenshot_plugin.snap({});
      image(res);
    `;

    const res = await execTool.handler({ code }, mockCtx);
    assert.equal(res.ok, true, res.error);
    assert.ok(res.images && res.images.length === 1);
    assert.equal(res.images[0].data, "pluginBase64Image");
    assert.equal(res.images[0].mimeType, "image/png");
  });
});
