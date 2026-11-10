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
      } else if (req.url === "/pointer") {
        res.end(`<!doctype html><html><head><title>Pointer fixture</title></head><body><button id="play" onclick="document.title='Pointer clicked';this.requestPointerLock()">Play</button></body></html>`);
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
});
