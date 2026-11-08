import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createTestEnvironment } from "./helpers.js";
import { searchTool } from "../src/tools/search.js";

test("search tool: content and files modes", async (t) => {
  const env = await createTestEnvironment();

  t.after(async () => {
    await env.cleanup();
  });

  // Seed test files
  await fs.writeFile(
    path.join(env.workspaceDir, "alpha.ts"),
    "const foo = 1;\nfunction calculate() {\n  return 42;\n}\n"
  );
  await fs.writeFile(
    path.join(env.workspaceDir, "beta.js"),
    "const bar = 2;\nfunction calculate() {\n  return 99;\n}\n"
  );
  await fs.mkdir(path.join(env.workspaceDir, "nested"), { recursive: true });
  await fs.writeFile(
    path.join(env.workspaceDir, "nested", "gamma.ts"),
    "// special token\nconst token = 'SECRET';\n"
  );

  await t.test("content search finds matches with line numbers", async () => {
    const res = await searchTool.handler({ pattern: "calculate" }, env.ctx);
    assert.equal(res.ok, true);
    assert.equal(res.data.matches.length, 2);
    assert.ok(res.data.matches.some((m: any) => m.file === "alpha.ts" && m.line === 2));
    assert.ok(res.data.matches.some((m: any) => m.file === "beta.js" && m.line === 2));
  });

  await t.test("content search with glob filter", async () => {
    const res = await searchTool.handler(
      { pattern: "calculate", glob: "*.ts" },
      env.ctx
    );
    assert.equal(res.ok, true);
    assert.equal(res.data.matches.length, 1);
    assert.equal(res.data.matches[0].file, "alpha.ts");
  });

  await t.test("files search mode", async () => {
    const res = await searchTool.handler(
      { pattern: "gamma", mode: "files" },
      env.ctx
    );
    assert.equal(res.ok, true);
    assert.equal(res.data.matches.length, 1);
    assert.equal(res.data.matches[0].file, "nested/gamma.ts");
  });
});
