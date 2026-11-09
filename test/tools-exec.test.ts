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
});
