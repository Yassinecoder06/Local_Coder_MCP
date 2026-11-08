import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createTestEnvironment } from "./helpers.js";
import { browserCheckTool } from "../src/tools/browser.js";
import { toCallToolResult } from "../src/core/result.js";

const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/pXcAAAAASUVORK5CYII=",
  "base64",
);

test("browser_check returns screenshot MCP image content", async (t) => {
  assert.equal(browserCheckTool.risk, "read");
  const env = await createTestEnvironment();
  t.after(async () => env.cleanup());

  const fakeChromium = path.join(env.tempDir, "chromium");
  await fs.writeFile(
    fakeChromium,
    `#!/usr/bin/env node\nconst fs = require('node:fs');\nconst out = process.argv.find((arg) => arg.startsWith('--screenshot='))?.slice('--screenshot='.length);\nif (!out) process.exit(2);\nfs.writeFileSync(out, Buffer.from('${tinyPng.toString("base64")}', 'base64'));\n`,
    { mode: 0o755 },
  );
  env.ctx.config.chromiumPath = fakeChromium;

  const result = await browserCheckTool.handler({ url: "http://127.0.0.1:3000", width: 640, height: 480 }, env.ctx);
  assert.equal(result.ok, true);
  assert.equal(result.data.width, 640);
  assert.equal(result.images?.[0]?.mimeType, "image/png");
  assert.equal(result.images?.[0]?.data, tinyPng.toString("base64"));

  const wireResult = toCallToolResult(result, 60_000);
  assert.ok(wireResult.content.some((block) => block.type === "image"));
  assert.equal(wireResult.structuredContent?.ok, true);
});

test("browser_check rejects non-HTTP schemes", async (t) => {
  const env = await createTestEnvironment();
  t.after(async () => env.cleanup());
  const result = await browserCheckTool.handler({ url: "file:///etc/passwd" }, env.ctx);
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /HTTP and HTTPS/);
});
