import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { after, before, describe, it } from "node:test";
import { browserCheckTool } from "../src/tools/browser.js";
import { createTestEnvironment, type TestEnvironment } from "./helpers.js";

describe("browser_check resilience", () => {
  let env: TestEnvironment;
  let appServer: http.Server;
  let stalledServer: http.Server;
  let appUrl = "";
  let stalledUrl = "";
  let chromiumAvailable = false;
  let previousChromiumPath: string | undefined;

  before(async () => {
    env = await createTestEnvironment();
    previousChromiumPath = process.env.CHROMIUM_PATH;
    const chromiumPath = [process.env.CHROMIUM_PATH, "/usr/bin/chromium", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"]
      .find((candidate) => candidate && fs.existsSync(candidate));
    if (chromiumPath) process.env.CHROMIUM_PATH = chromiumPath;
    chromiumAvailable = Boolean(chromiumPath);

    stalledServer = http.createServer((_req, _res) => { /* leave stylesheet request pending */ });
    await new Promise<void>((resolve) => stalledServer.listen(0, "127.0.0.1", resolve));
    const stalledPort = (stalledServer.address() as { port: number }).port;
    stalledUrl = `http://127.0.0.1:${stalledPort}/never.css`;

    appServer = http.createServer((req, res) => {
      if (req.url === "/never.css") return;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      if (req.url === "/hang") {
        res.end(`<!doctype html><html><head><title>Hang fixture</title><link rel="stylesheet" href="${stalledUrl}"></head><body><h1>Rendered before load</h1></body></html>`);
      } else if (req.url === "/import-hang") {
        res.end(`<!doctype html><html><head><title>CSS Import Hang</title><style>@import url("${stalledUrl}");</style></head><body><h1>Rendered with CSS @import</h1></body></html>`);
      } else if (req.url === "/pointer") {
        res.end(`<!doctype html><html><head><title>Pointer fixture</title></head><body><button id="play" onclick="document.title='Pointer clicked';this.requestPointerLock()">Play</button></body></html>`);
      } else if (req.url === "/pointer-game") {
        res.end(`<!doctype html><html><head><title>Pointer game fixture</title></head><body><canvas id="c" width="320" height="240"></canvas><button id="start" onclick="document.title='Game Started';document.getElementById('c').requestPointerLock();function loop(){requestAnimationFrame(loop);}requestAnimationFrame(loop);">Start</button></body></html>`);
      } else if (req.url === "/webgl-busy") {
        res.end(`<!doctype html><html><head><title>WebGL Busy fixture</title></head><body><canvas id="c" width="2048" height="2048"></canvas><button id="interact" onclick="document.title='Interacted'">Interact</button><script>
          const c = document.getElementById("c"), gl = c.getContext("webgl") || c.getContext("experimental-webgl");
          const p = new Uint8Array(4);
          function loop() {
            if (gl) {
              gl.clearColor(0.2, 0.4, 0.6, 1);
              gl.clear(gl.COLOR_BUFFER_BIT);
              gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, p);
            }
            requestAnimationFrame(loop);
          }
          requestAnimationFrame(loop);
        </script></body></html>`);
      } else {
        res.end(`<!doctype html><html><head><title>Busy canvas fixture</title></head><body><canvas id="game"></canvas><button id="play">Play</button><script>
          const c=document.querySelector('canvas'), x=c.getContext('2d');
          function frame(){ for(let i=0;i<50000;i++) Math.sqrt(i); x.fillRect(0,0,1,1); requestAnimationFrame(frame); }
          requestAnimationFrame(frame);
        </script></body></html>`);
      }
    });
    await new Promise<void>((resolve) => appServer.listen(0, "127.0.0.1", resolve));
    appUrl = `http://127.0.0.1:${(appServer.address() as { port: number }).port}`;
  });

  after(async () => {
    if (previousChromiumPath === undefined) delete process.env.CHROMIUM_PATH;
    else process.env.CHROMIUM_PATH = previousChromiumPath;
    appServer?.closeAllConnections();
    stalledServer?.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => appServer?.close(() => resolve()) ?? resolve()),
      new Promise<void>((resolve) => stalledServer?.close(() => resolve()) ?? resolve()),
      env?.cleanup(),
    ]);
  });

  it("continues after a stylesheet keeps the load event pending", async (t) => {
    if (!chromiumAvailable) return t.skip("Chromium is not installed");
    const result = await browserCheckTool.handler({ url: `${appUrl}/hang`, wait_ms: 0 }, env.ctx);
    assert.equal(result.ok, true, result.summary);
    assert.equal(result.data?.title, "Hang fixture");
    assert.ok((result.data as any).warnings.some((warning: string) => warning.includes("page 'load' did not finish")));
    assert.ok((result.data as any).warnings.some((warning: string) => warning.includes(stalledUrl)));
    assert.ok((result.data as any).warnings.some((warning: string) => warning.includes("Screenshot unavailable")) || result.images?.length);
  });

  it("stubs pointer lock so a Play action completes and reports the stub", async (t) => {
    if (!chromiumAvailable) return t.skip("Chromium is not installed");
    const result = await browserCheckTool.handler({
      url: `${appUrl}/pointer`, wait_ms: 0, actions: [{ type: "click", selector: "#play" }],
    }, env.ctx);
    assert.equal(result.ok, true);
    assert.equal(result.data?.title, "Pointer clicked");
    assert.ok((result.data as any).browserApiStubsAvailable.includes("requestPointerLock"));
    assert.ok((result.data as any).browserApiStubsUsed.includes("requestPointerLock"));
  });

  it("throttles a busy animation loop and can interact with the page", async (t) => {
    if (!chromiumAvailable) return t.skip("Chromium is not installed");
    const result = await browserCheckTool.handler({
      url: `${appUrl}/busy`, wait_ms: 100, throttle_raf: 10,
      actions: [{ type: "click", selector: "#play" }],
    }, env.ctx);
    assert.equal(result.ok, true);
    assert.equal(result.data?.title, "Busy canvas fixture");
    assert.ok(result.images?.length);
  });

  it("handles CSS @import hang without losing screenshot and stays within 8000ms budget", async (t) => {
    if (!chromiumAvailable) return t.skip("Chromium is not installed");
    const ctxWithBudget = { ...env.ctx, callBudgetMs: 8000 };
    const t0 = Date.now();
    const result = await browserCheckTool.handler({ url: `${appUrl}/import-hang`, wait_ms: 100 }, ctxWithBudget);
    const elapsed = Date.now() - t0;
    assert.equal(result.ok, true);
    assert.equal(result.data?.title, "CSS Import Hang");
    assert.ok(elapsed < 8000, `Expected < 8000ms, took ${elapsed}ms`);
    assert.ok(result.images && result.images.length > 0, "Screenshot should be captured");
    assert.ok(
      (result.data as any).warnings.some((w: string) => w.includes("Aborted slow third-party request") || w.includes("page 'load' did not finish"))
    );
  });

  it("handles canvas.requestPointerLock() followed by a game loop", async (t) => {
    if (!chromiumAvailable) return t.skip("Chromium is not installed");
    const result = await browserCheckTool.handler({
      url: `${appUrl}/pointer-game`,
      wait_ms: 100,
      actions: [{ type: "click", selector: "#start" }],
    }, env.ctx);
    assert.equal(result.ok, true);
    assert.equal(result.data?.title, "Game Started");
    assert.ok((result.data as any).browserApiStubsUsed.includes("requestPointerLock"));
    assert.ok(result.images && result.images.length > 0, "Screenshot should be captured");
  });

  it("handles WebGL busy loop with 2048x2048 canvas and readPixels", async (t) => {
    if (!chromiumAvailable) return t.skip("Chromium is not installed");
    const ctxWithBudget = { ...env.ctx, callBudgetMs: 8000 };
    const t0 = Date.now();
    const result = await browserCheckTool.handler({
      url: `${appUrl}/webgl-busy`,
      wait_ms: 100,
      actions: [{ type: "click", selector: "#interact" }],
    }, ctxWithBudget);
    const elapsed = Date.now() - t0;
    assert.equal(result.ok, true);
    assert.equal(result.data?.title, "Interacted");
    assert.ok(elapsed < 8000, `Expected < 8000ms, took ${elapsed}ms`);
    assert.ok(result.images && result.images.length > 0, "Screenshot should be captured");
  });
});
