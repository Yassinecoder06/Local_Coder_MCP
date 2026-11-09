import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { parsePluginImport, stripJsonCommentsAndTrailingCommas } from "../src/plugins/import.js";
import { createAdminApp } from "../src/admin/app.js";
import { createTestEnvironment } from "./helpers.js";

test("plugin import parser: parsePluginImport", async (t) => {
  await t.test("strips comments and trailing commas in JSON", () => {
    const raw = `
      {
        // Line comment
        /* Multi-line
           comment */
        "mcpServers": {
          "playwright": {
            "command": "npx",
            "args": ["-y", "@playwright/mcp@latest",],
          },
        },
      }
    `;
    const stripped = stripJsonCommentsAndTrailingCommas(raw);
    const parsed = JSON.parse(stripped);
    assert.ok(parsed.mcpServers.playwright);
    assert.equal(parsed.mcpServers.playwright.command, "npx");
    assert.deepEqual(parsed.mcpServers.playwright.args, ["-y", "@playwright/mcp@latest"]);
  });

  await t.test("parses mcpServers config (Claude / Cursor / standard format)", () => {
    const text = JSON.stringify({
      mcpServers: {
        "github-mcp": {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github"],
          env: {
            GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_1234567890",
          },
        },
      },
    });

    const result = parsePluginImport(text);
    assert.equal(result.plugins.length, 1);
    const p = result.plugins[0];
    assert.equal(p.id, "github-mcp");
    assert.equal(p.name, "Github Mcp");
    assert.equal(p.transport.type, "stdio");
    if (p.transport.type === "stdio") {
      assert.equal(p.transport.command, "npx");
      assert.deepEqual(p.transport.args, ["-y", "@modelcontextprotocol/server-github"]);
      assert.equal(p.transport.env?.GITHUB_PERSONAL_ACCESS_TOKEN, "ghp_1234567890");
    }
    assert.equal(p.needsSecrets.length, 0);
  });

  await t.test("parses VS Code servers config and warns on sse transport", () => {
    const text = JSON.stringify({
      servers: {
        "local-dev": {
          type: "sse",
          url: "http://localhost:3000/sse",
          headers: {
            Authorization: "Bearer valid_token",
          },
        },
      },
    });

    const result = parsePluginImport(text);
    assert.equal(result.plugins.length, 1);
    const p = result.plugins[0];
    assert.equal(p.id, "local-dev");
    assert.equal(p.name, "Local Dev");
    assert.equal(p.transport.type, "http");
    if (p.transport.type === "http") {
      assert.equal(p.transport.url, "http://localhost:3000/sse");
      assert.equal(p.transport.headers?.Authorization, "Bearer valid_token");
    }
    assert.ok(result.warnings.some((w) => w.includes("SSE transport is deprecated")));
  });

  await t.test("parses single server object with stdio", () => {
    const text = JSON.stringify({
      command: "npx",
      args: ["-y", "@playwright/mcp@1.2.3", "--browser", "chromium"],
    });

    const result = parsePluginImport(text);
    assert.equal(result.plugins.length, 1);
    const p = result.plugins[0];
    assert.equal(p.id, "playwright");
    assert.equal(p.name, "Playwright");
    assert.equal(p.transport.type, "stdio");
    if (p.transport.type === "stdio") {
      assert.equal(p.transport.command, "npx");
      assert.deepEqual(p.transport.args, ["-y", "@playwright/mcp@1.2.3", "--browser", "chromium"]);
    }
  });

  await t.test("parses shell command with npx and quotes", () => {
    const text = `npx -y @playwright/mcp@1.2.3 --flag "quoted value with spaces"`;
    const result = parsePluginImport(text);
    assert.equal(result.plugins.length, 1);
    const p = result.plugins[0];
    assert.equal(p.id, "playwright");
    assert.equal(p.name, "Playwright");
    assert.equal(p.transport.type, "stdio");
    if (p.transport.type === "stdio") {
      assert.equal(p.transport.command, "npx");
      assert.deepEqual(p.transport.args, ["-y", "@playwright/mcp@1.2.3", "--flag", "quoted value with spaces"]);
    }
  });

  await t.test("parses shell command with leading environment assignments and uvx", () => {
    const text = `FOO=bar SECRET="my secret" uvx mcp-server-sqlite --db /tmp/test.db`;
    const result = parsePluginImport(text);
    assert.equal(result.plugins.length, 1);
    const p = result.plugins[0];
    assert.equal(p.id, "sqlite");
    assert.equal(p.name, "Sqlite");
    assert.equal(p.transport.type, "stdio");
    if (p.transport.type === "stdio") {
      assert.equal(p.transport.command, "uvx");
      assert.deepEqual(p.transport.args, ["mcp-server-sqlite", "--db", "/tmp/test.db"]);
      assert.equal(p.transport.env?.FOO, "bar");
      assert.equal(p.transport.env?.SECRET, "my secret");
    }
  });

  await t.test("parses docker run command and produces container socket warning", () => {
    const text = `docker run -i --rm -e API_KEY=secret123 mcp/fetch`;
    const result = parsePluginImport(text);
    assert.equal(result.plugins.length, 1);
    const p = result.plugins[0];
    assert.equal(p.id, "fetch");
    assert.equal(p.name, "Fetch");
    assert.equal(p.transport.type, "stdio");
    if (p.transport.type === "stdio") {
      assert.equal(p.transport.command, "docker");
    }
    assert.ok(result.warnings.some((w) => w.includes("Docker commands require the Docker socket")));
  });

  await t.test("parses bare URL", () => {
    const text = `https://mcp.notion.com/mcp`;
    const result = parsePluginImport(text);
    assert.equal(result.plugins.length, 1);
    const p = result.plugins[0];
    assert.equal(p.id, "notion");
    assert.equal(p.name, "Notion");
    assert.equal(p.transport.type, "http");
    if (p.transport.type === "http") {
      assert.equal(p.transport.url, "https://mcp.notion.com/mcp");
    }
  });

  await t.test("detects placeholders in needsSecrets", () => {
    const text = JSON.stringify({
      mcpServers: {
        github: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github"],
          env: {
            GITHUB_TOKEN: "YOUR_GITHUB_TOKEN",
            OPENAI_API_KEY: "<api-key>",
            EMPTY_VAR: "",
            VALID_VAR: "real_token_12345",
          },
        },
        remote: {
          url: "https://example.com/mcp",
          headers: {
            Authorization: "Bearer YOUR_ACCESS_KEY",
            "X-Empty": "",
            "X-Valid": "valid_header_value",
          },
        },
      },
    });

    const result = parsePluginImport(text);
    assert.equal(result.plugins.length, 2);

    const gh = result.plugins.find((p) => p.id === "github");
    assert.ok(gh);
    assert.deepEqual(gh.needsSecrets, [
      { key: "GITHUB_TOKEN", where: "env" },
      { key: "OPENAI_API_KEY", where: "env" },
      { key: "EMPTY_VAR", where: "env" },
    ]);

    const remote = result.plugins.find((p) => p.id === "remote");
    assert.ok(remote);
    assert.deepEqual(remote.needsSecrets, [
      { key: "Authorization", where: "header" },
      { key: "X-Empty", where: "header" },
    ]);
  });

  await t.test("handles garbage input gracefully without throwing", () => {
    const garbageInputs = [
      "",
      "    ",
      "some random notes that are definitely not an mcp server config or command",
      "{ invalid json: true, ",
      "!!!###$$$",
    ];

    for (const input of garbageInputs) {
      const res = parsePluginImport(input);
      assert.ok(Array.isArray(res.plugins));
      assert.ok(Array.isArray(res.warnings));
      assert.equal(res.plugins.length, 0);
    }
  });
});

test("Admin API POST /api/plugins/import/preview", async (t) => {
  const env = await createTestEnvironment();

  const app = createAdminApp({
    config: env.config,
    activity: env.activity,
    skills: env.skills,
    commands: env.commands,
    sessionManager: {
      count: () => 0,
      applyApprovalModeLive: async () => {},
    } as any,
    pluginHub: {
      list: () => [],
      get: () => undefined,
      add: async () => ({} as any),
      update: async () => ({} as any),
      remove: async () => {},
      restart: async () => ({} as any),
      setToolEnabled: async () => ({} as any),
      publishedTools: () => [],
      callTool: async () => ({} as any),
      execTools: () => [],
      callPluginTool: async () => ({} as any),
      subscribe: () => () => {},
      start: async () => {},
      stop: async () => {},
    },
  });

  const server = http.createServer(app);
  let baseUrl = "";

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as any).port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await env.cleanup();
  });

  await t.test("returns 400 when text is missing or empty", async () => {
    const res = await fetch(`${baseUrl}/api/plugins/import/preview`, {
      method: "POST",
      headers: { host: "localhost:8788", "Content-Type": "application/json" },
      body: JSON.stringify({ text: "" }),
    });

    assert.equal(res.status, 400);
    const data = (await res.json()) as any;
    assert.match(data.error, /Missing or empty 'text'/);
  });

  await t.test("returns 400 when text cannot be parsed into plugins", async () => {
    const res = await fetch(`${baseUrl}/api/plugins/import/preview`, {
      method: "POST",
      headers: { host: "localhost:8788", "Content-Type": "application/json" },
      body: JSON.stringify({ text: "random completely unparseable content" }),
    });

    assert.equal(res.status, 400);
    const data = (await res.json()) as any;
    assert.match(data.error, /Could not parse any plugin configurations/);
  });

  await t.test("returns 200 with preview result on valid input", async () => {
    const res = await fetch(`${baseUrl}/api/plugins/import/preview`, {
      method: "POST",
      headers: { host: "localhost:8788", "Content-Type": "application/json" },
      body: JSON.stringify({ text: "npx -y @playwright/mcp@latest" }),
    });

    assert.equal(res.status, 200);
    const data = (await res.json()) as any;
    assert.ok(data.plugins);
    assert.equal(data.plugins.length, 1);
    assert.equal(data.plugins[0].id, "playwright");
    assert.equal(data.plugins[0].name, "Playwright");
  });
});
