/**
 * Owned by agy1. Headless browser verification tool using playwright-core.
 * Risk: read (inspection and verification only).
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { z } from "zod";
import { defineTool, type ToolModule } from "../core/types.js";
import { ok, fail } from "../core/result.js";


/** A writable per-process home for Chromium, independent of the container's HOME. */
function chromiumHomeEnv(): Record<string, string> {
  const home = path.join(os.tmpdir(), "local-coder-chromium");
  for (const dir of ["", ".config", ".cache"]) fs.mkdirSync(path.join(home, dir), { recursive: true });
  return { HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_CACHE_HOME: path.join(home, ".cache") };
}

export function getChromiumPath(): string {
  return process.env.CHROMIUM_PATH || "/usr/bin/chromium";
}

interface StaticServer {
  url: string;
  close: () => Promise<void>;
}

async function startStaticServer(dir: string, initialFile: string): Promise<StaticServer> {
  const mimeTypes: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".wasm": "application/wasm",
    ".txt": "text/plain; charset=utf-8",
  };

  const server = http.createServer((req, res) => {
    try {
      const parsedUrl = new URL(req.url || "/", "http://127.0.0.1");
      let pathname = decodeURIComponent(parsedUrl.pathname);
      if (pathname === "/" || pathname === "") {
        pathname = `/${initialFile}`;
      }
      const safePath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, "");
      const fullPath = path.join(dir, safePath);

      if (!fullPath.startsWith(dir)) {
        res.statusCode = 403;
        res.end("Forbidden");
        return;
      }

      if (pathname === "/favicon.ico" && !fs.existsSync(fullPath)) {
        res.statusCode = 204;
        res.end();
        return;
      }

      if (!fs.existsSync(fullPath)) {
        res.statusCode = 404;
        res.end("Not Found");
        return;
      }

      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        const indexPath = path.join(fullPath, "index.html");
        if (fs.existsSync(indexPath)) {
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          fs.createReadStream(indexPath).pipe(res);
          return;
        }
        res.statusCode = 404;
        res.end("Not Found");
        return;
      }

      const ext = path.extname(fullPath).toLowerCase();
      const contentType = mimeTypes[ext] || "application/octet-stream";
      res.setHeader("Content-Type", contentType);
      fs.createReadStream(fullPath).pipe(res);
    } catch {
      res.statusCode = 500;
      res.end("Internal Server Error");
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.on("error", reject);
  });

  const port = (server.address() as any).port;
  return {
    url: `http://127.0.0.1:${port}/${encodeURIComponent(initialFile)}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const actionSchema = z.object({
  type: z.enum(["click", "type", "press", "wait"]).describe("Action to perform"),
  selector: z.string().optional().describe("CSS selector for click/type/press"),
  text: z.string().optional().describe("Text to enter for 'type'"),
  key: z.string().optional().describe("Key to press for 'press' (e.g. 'Enter', 'Tab', 'ArrowDown')"),
  ms: z.number().int().min(0).max(10000).optional().describe("Duration to wait in milliseconds for 'wait'"),
});

export const browserCheckTool = defineTool({
  name: "browser_check",
  title: "Browser Check",
  description:
    "Load a URL or local HTML file in headless Chromium, execute optional interactions, collect console errors and failed requests, and capture a screenshot.",
  group: "system",
  risk: "read",
  input: {
    url: z.string().optional().describe("Public or local URL to navigate to (e.g. http://localhost:3000)"),
    path: z
      .string()
      .optional()
      .describe(
        "Path to a local HTML file in the workspace (served via a temporary local static server supporting ES modules and relative assets)"
      ),
    wait_ms: z.number().int().min(0).max(30000).default(1500).describe("Milliseconds to wait after navigation before capturing state"),
    viewport: z.enum(["desktop", "mobile"]).default("desktop").describe("Viewport size: 'desktop' (1280x800) or 'mobile' (390x844)"),
    actions: z.array(actionSchema).optional().describe("Optional sequence of flat action objects {type, selector, text, key, ms}"),
    full_page: z.boolean().default(false).describe("Capture full scrollable page screenshot if true"),
  },
  handler: async (args, ctx) => {
    if (!args.url && !args.path) {
      return fail("browser_check", "Either 'url' or 'path' must be provided");
    }

    const chromiumPath = getChromiumPath();
    if (!fs.existsSync(chromiumPath)) {
      return fail(
        "browser_check",
        `Chromium executable not found at ${chromiumPath}. Install chromium (e.g. 'apt-get install -y chromium' or set CHROMIUM_PATH).`
      );
    }

    let staticServer: StaticServer | null = null;
    let browser: Browser | null = null;

    try {
      let targetUrl = args.url;

      if (args.path) {
        const absPath = ctx.workspace.resolve(args.path);
        if (!fs.existsSync(absPath)) {
          return fail("browser_check", `File not found: ${args.path}`);
        }
        const folder = path.dirname(absPath);
        const file = path.basename(absPath);
        staticServer = await startStaticServer(folder, file);
        targetUrl = staticServer.url;
      }

      if (!targetUrl) {
        return fail("browser_check", "Failed to resolve target URL");
      }

      // Enforce 30s total timeout
      const result = await Promise.race([
        (async () => {
          browser = await chromium.launch({
            executablePath: chromiumPath,
            headless: true,
            args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
            // HOME may be unwritable inside the container (e.g. the herdr override maps it to a
            // root-owned mount point); Chromium's profile and crashpad need a writable home.
            env: { ...process.env, ...chromiumHomeEnv() },
          });

          const isMobile = args.viewport === "mobile";
          const context = await browser.newContext(
            isMobile
              ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
              : { viewport: { width: 1280, height: 800 } }
          );

          const page: Page = await context.newPage();

          const consoleMessages: Array<{ type: string; text: string; location?: string }> = [];
          page.on("console", (msg) => {
            const locUrl = msg.location().url;
            if (locUrl && locUrl.endsWith("/favicon.ico")) return;
            if (msg.text().includes("favicon.ico")) return;
            consoleMessages.push({
              type: msg.type(),
              text: msg.text(),
              location: locUrl ? `${locUrl}:${msg.location().lineNumber}` : undefined,
            });
          });

          const pageErrors: string[] = [];
          page.on("pageerror", (err) => {
            pageErrors.push(err.message || String(err));
          });

          const failedRequests: Array<{ url: string; status?: number; error?: string }> = [];
          page.on("requestfailed", (req) => {
            if (req.url().endsWith("/favicon.ico")) return;
            failedRequests.push({
              url: req.url(),
              error: req.failure()?.errorText || "Network failure",
            });
          });
          page.on("response", (res) => {
            if (res.status() >= 400) {
              const url = res.url();
              if (url.endsWith("/favicon.ico")) return;
              failedRequests.push({
                url,
                status: res.status(),
                error: `HTTP ${res.status()}`,
              });
            }
          });

          await page.goto(targetUrl, { timeout: 20000, waitUntil: "load" });

          // Execute optional actions
          if (args.actions && args.actions.length > 0) {
            for (const action of args.actions) {
              if (action.type === "click" && action.selector) {
                await page.click(action.selector, { timeout: 5000 });
              } else if (action.type === "type" && action.selector && action.text !== undefined) {
                await page.fill(action.selector, action.text, { timeout: 5000 });
              } else if (action.type === "press") {
                if (action.selector && action.key) {
                  await page.press(action.selector, action.key, { timeout: 5000 });
                } else if (action.key) {
                  await page.keyboard.press(action.key);
                }
              } else if (action.type === "wait") {
                await page.waitForTimeout(action.ms ?? 500);
              }
            }
          }

          // Wait after navigation/actions
          const waitMs = args.wait_ms ?? 1500;
          if (waitMs > 0) {
            await page.waitForTimeout(waitMs);
          }

          const title = await page.title();
          const finalUrl = page.url();

          // Screenshot with ~1 MB cap
          let screenshotBuffer = await page.screenshot({
            fullPage: Boolean(args.full_page),
            type: "png",
          });

          if (screenshotBuffer.length > 1_000_000 && args.full_page) {
            screenshotBuffer = await page.screenshot({
              fullPage: false,
              type: "png",
            });
          }

          const base64Data = screenshotBuffer.toString("base64");

          // Sort console messages: errors first, then warnings, then others
          const sortedConsole = [...consoleMessages].sort((a, b) => {
            const score = (t: string) => (t === "error" ? 0 : t === "warning" ? 1 : 2);
            return score(a.type) - score(b.type);
          });

          const errorConsoleCount = consoleMessages.filter((c) => c.type === "error").length;
          const totalErrors = pageErrors.length + errorConsoleCount;
          const failedReqCount = failedRequests.length;

          let summary: string;
          if (totalErrors === 0 && failedReqCount === 0) {
            summary = `Loaded ${finalUrl} with 0 errors`;
          } else {
            const parts: string[] = [];
            if (totalErrors > 0) {
              parts.push(`${totalErrors} console error${totalErrors === 1 ? "" : "s"}`);
            }
            if (failedReqCount > 0) {
              parts.push(`${failedReqCount} failed request${failedReqCount === 1 ? "" : "s"}`);
            }
            summary = `${parts.join(", ")} on ${finalUrl}`;
          }

          return {
            ok: true,
            tool: "browser_check",
            summary,
            data: {
              title,
              url: finalUrl,
              console: sortedConsole,
              pageErrors,
              failedRequests,
            },
            images: [
              {
                data: base64Data,
                mimeType: "image/png",
              },
            ],
          };
        })(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("browser_check timed out after 30s")), 30000)
        ),
      ]);

      return result;
    } catch (err) {
      return fail("browser_check", err);
    } finally {
      if (browser) {
        await (browser as Browser).close().catch(() => undefined);
      }
      if (staticServer) {
        await staticServer.close().catch(() => undefined);
      }
    }
  },
});

const tools: ToolModule = [browserCheckTool];
export default tools;
