import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createTestEnvironment } from "./helpers.js";
import { workspaceInfoTool, workspaceSwitchTool } from "../src/tools/workspace.js";
import { statusTool, fetchUrlTool } from "../src/tools/system.js";

test("workspace and system tools", async (t) => {
  const env = await createTestEnvironment();

  t.after(async () => {
    await env.cleanup();
  });

  await t.test("workspace_info detects stack and instructions", async () => {
    await fs.writeFile(
      path.join(env.workspaceDir, "package.json"),
      JSON.stringify({ name: "my-app", dependencies: { react: "^18.0.0" }, scripts: { build: "tsc" } })
    );
    await fs.writeFile(
      path.join(env.workspaceDir, "AGENTS.md"),
      "# Agent Guidelines\nAlways write tests."
    );

    const res = await workspaceInfoTool.handler({}, env.ctx);
    assert.equal(res.ok, true);
    assert.ok(res.data.stack.includes("node"));
    assert.ok(res.data.stack.includes("react"));
    assert.equal(res.data.scripts?.build, "tsc");
    assert.match(res.data.instructions, /Always write tests/);
  });

  await t.test("workspace_switch changes active directory and returns absolute path with stack & git summary", async () => {
    const sub = path.join(env.workspaceDir, "subproject");
    await fs.mkdir(sub, { recursive: true });
    await fs.writeFile(
      path.join(sub, "package.json"),
      JSON.stringify({ name: "sub", dependencies: { typescript: "^5.0.0" } })
    );

    const switchRes = await workspaceSwitchTool.handler({ path: "subproject" }, env.ctx);
    assert.equal(switchRes.ok, true);
    assert.equal(env.workspace.active(), sub);
    assert.equal(switchRes.data.active, sub);

    // Summary must show absolute path and never just "."
    assert.match(switchRes.summary, new RegExp(`Active workspace is now ${sub.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.ok(switchRes.data.stack.includes("typescript"));
    assert.ok("git" in switchRes.data);

    // Switch back
    const switchBackRes = await workspaceSwitchTool.handler({ path: ".." }, env.ctx);
    assert.equal(env.workspace.active(), env.workspaceDir);
    assert.match(
      switchBackRes.summary,
      new RegExp(`Active workspace is now ${env.workspaceDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );
  });

  await t.test("status tool returns server metadata", async () => {
    const res = await statusTool.handler({}, env.ctx);
    assert.equal(res.ok, true);
    assert.equal(res.data.version, "1.0.0");
    assert.equal(res.data.auth_mode, "both");
  });

  await t.test("fetch_url parses html and caps size", async () => {
    // Mock global fetch for this test
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      const html = `<html>
        <head><title>Test</title><style>.bad{color:red;}</style></head>
        <body>
          <header><nav>Menu</nav></header>
          <h1>Test Title</h1>
          <p>This is a <a href="https://example.com">link</a>.</p>
          <script>console.log("bad");</script>
        </body>
      </html>`;
      return new Response(html, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    };

    try {
      const res = await fetchUrlTool.handler(
        { url: "https://example.com/doc", max_bytes: 1000 },
        env.ctx
      );
      assert.equal(res.ok, true);
      assert.match(res.data.content, /# Test Title/);
      assert.match(res.data.content, /\[link\]\(https:\/\/example\.com\)/);
      assert.doesNotMatch(res.data.content, /console\.log/);
      assert.doesNotMatch(res.data.content, /\.bad/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
