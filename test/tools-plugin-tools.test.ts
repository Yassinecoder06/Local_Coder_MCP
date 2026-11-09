import test from "node:test";
import assert from "node:assert/strict";
import { pluginToolsTool } from "../src/tools/plugin-tools.js";
import { createTestEnvironment } from "./helpers.js";

test("plugin_tools tool", async (t) => {
  const env = await createTestEnvironment();

  t.after(async () => {
    await env.cleanup();
  });

  await t.test("returns ok: true with hint when ctx.plugins is undefined", async () => {
    const mockCtx = {
      ...env.ctx,
      plugins: undefined,
    };

    const res = await pluginToolsTool.handler({}, mockCtx);
    assert.equal(res.ok, true);
    assert.match(res.summary, /No plugins are configured\. Add one in Admin → Plugins\./);
    assert.equal(res.data?.hint, "No plugins are configured. Add one in Admin → Plugins.");
    assert.deepEqual(res.data?.plugins, []);
  });

  await t.test("returns ok: true with hint when ctx.plugins.list() is empty", async () => {
    const mockCtx = {
      ...env.ctx,
      plugins: {
        list: () => [],
        call: async () => ({ ok: true, tool: "test", summary: "ok" }),
      },
    };

    const res = await pluginToolsTool.handler({}, mockCtx);
    assert.equal(res.ok, true);
    assert.match(res.summary, /No plugins are configured\. Add one in Admin → Plugins\./);
    assert.deepEqual(res.data?.plugins, []);
  });

  await t.test("lists ready plugins with compact summaries and blocked hints", async () => {
    const mockCtx = {
      ...env.ctx,
      plugins: {
        list: () => [
          {
            plugin: "chrome-devtools",
            name: "navigate",
            description: "Navigates the browser to a URL. Supports history navigation.",
            inputSchema: { type: "object", properties: { url: { type: "string" } } },
            enabled: true,
            published: true,
            execAllowed: true,
          },
          {
            plugin: "chrome-devtools",
            name: "click",
            description: "Clicks on an element matching selector.",
            inputSchema: { type: "object", properties: { selector: { type: "string" } } },
            enabled: true,
            published: true,
            execAllowed: false,
          },
          {
            plugin: "postgres",
            name: "query",
            description: "Run SQL query on the database. Read-only by default.",
            inputSchema: { type: "object", properties: { sql: { type: "string" } } },
            enabled: true,
            published: true,
            execAllowed: true,
          },
        ],
        call: async () => ({ ok: true, tool: "test", summary: "ok" }),
      },
    };

    const res = await pluginToolsTool.handler({}, mockCtx);
    assert.equal(res.ok, true);
    assert.equal(res.data?.plugins?.length, 2);

    const chromePlugin = res.data?.plugins?.find((p: any) => p.id === "chrome-devtools");
    assert.ok(chromePlugin);
    assert.equal(chromePlugin.toolCount, 2);
    assert.equal(chromePlugin.execAllowedCount, 1);
    assert.deepEqual(chromePlugin.tools, [
      "navigate — Navigates the browser to a URL.",
      "click — Clicks on an element matching selector. [blocked: not read-only; mark plugin Trusted to allow]",
    ]);

    const pgPlugin = res.data?.plugins?.find((p: any) => p.id === "postgres");
    assert.ok(pgPlugin);
    assert.equal(pgPlugin.toolCount, 1);
    assert.equal(pgPlugin.execAllowedCount, 1);
    assert.deepEqual(pgPlugin.tools, ["query — Run SQL query on the database."]);
  });

  await t.test("returns full inputSchema when plugin and tools are specified", async () => {
    const mockCtx = {
      ...env.ctx,
      plugins: {
        list: () => [
          {
            plugin: "chrome-devtools",
            name: "navigate",
            description: "Navigates to a URL",
            inputSchema: {
              type: "object",
              properties: { url: { type: "string", description: "Target URL" } },
              required: ["url"],
            },
            enabled: true,
            published: true,
            execAllowed: true,
          },
          {
            plugin: "chrome-devtools",
            name: "click",
            description: "Clicks on an element",
            inputSchema: {
              type: "object",
              properties: { selector: { type: "string" } },
            },
            enabled: true,
            published: true,
            execAllowed: false,
          },
        ],
        call: async () => ({ ok: true, tool: "test", summary: "ok" }),
      },
    };

    // Supports underscore in plugin id: chrome_devtools -> chrome-devtools
    const res = await pluginToolsTool.handler(
      { plugin: "chrome_devtools", tools: ["navigate"] },
      mockCtx
    );
    assert.equal(res.ok, true);
    assert.equal(res.data?.tools?.length, 1);
    assert.equal(res.data?.tools[0].name, "navigate");
    assert.deepEqual(res.data?.tools[0].inputSchema, {
      type: "object",
      properties: { url: { type: "string", description: "Target URL" } },
      required: ["url"],
    });
    assert.equal(res.data?.tools[0].execAllowed, true);
  });

  await t.test("fails gracefully when specified plugin is not found", async () => {
    const mockCtx = {
      ...env.ctx,
      plugins: {
        list: () => [
          {
            plugin: "postgres",
            name: "query",
            description: "Run SQL",
            inputSchema: {},
            enabled: true,
            published: true,
            execAllowed: true,
          },
        ],
        call: async () => ({ ok: true, tool: "test", summary: "ok" }),
      },
    };

    const res = await pluginToolsTool.handler({ plugin: "unknown-plugin", tools: ["abc"] }, mockCtx);
    assert.equal(res.ok, false);
    assert.match(res.error || "", /Plugin 'unknown-plugin' not found/);
  });
});
