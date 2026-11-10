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
import { fail } from "../core/result.js";


/** A writable per-process home for Chromium, independent of the container's HOME. */
function chromiumHomeEnv(): Record<string, string> {
  const home = path.join(os.tmpdir(), "local-coder-chromium");
  for (const dir of ["", ".config", ".cache"]) fs.mkdirSync(path.join(home, dir), { recursive: true });
  return { HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_CACHE_HOME: path.join(home, ".cache") };
}

export function getChromiumPath(): string {
  return process.env.CHROMIUM_PATH || "/usr/bin/chromium";
}

/**
 * Trims verbose Playwright / Chromium launch errors by removing the giant
 * <launching> command-line args line and extracting the first actionable/meaningful error log line.
 */
export function trimChromiumError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (!raw.includes("<launching>")) {
    return raw.replace(/^browserType\.[a-zA-Z0-9_]+:\s*/, "").trim();
  }

  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  // Extract headline before logs delimiter
  let headline = "";
  for (const line of lines) {
    if (line.includes("<launching>") || line.startsWith("===") || line.startsWith("Call log:")) {
      break;
    }
    const cleaned = line.replace(/^browserType\.[a-zA-Z0-9_]+:\s*/, "").trim();
    if (cleaned) {
      headline = cleaned;
      break;
    }
  }

  // Find candidate log lines (exclude launch headers, args line, separators)
  const candidateLines = lines.filter((line) => {
    if (line.includes("<launching>")) return false;
    if (line.includes("<launched>")) return false;
    if (/^[-=_\*]{3,}/.test(line) || /^[╔╚║╟═]+$/.test(line)) return false;
    if (/^(Call log|Browser logs):/i.test(line)) return false;
    if (line.replace(/^browserType\.[a-zA-Z0-9_]+:\s*/, "").trim() === headline) return false;
    return true;
  });

  // Prefer lines indicating error or stderr
  let meaningfulLine = candidateLines.find((l) =>
    /\[err\]|ERROR:|FATAL:|error|cannot open|failed|check failed|inconsistency/i.test(l)
  );

  // Fallback to process exit line or any candidate line
  if (!meaningfulLine) {
    meaningfulLine = candidateLines.find((l) => /<process did exit:|exitCode=/i.test(l)) || candidateLines[0];
  }

  if (meaningfulLine) {
    // Strip bullet points, [pid=...], [err] tags
    const cleanLog = meaningfulLine
      .replace(/^[-*]\s*/, "")
      .replace(/^(\[(pid=\d+|err)\]\s*)+/gi, "")
      .trim();

    if (headline && headline !== cleanLog) {
      const cleanHeadline = headline.replace(/[:.!?]$/, "");
      return `${cleanHeadline}: ${cleanLog}`;
    }
    return cleanLog;
  }

  return headline || "Headless Chromium failed to launch";
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
    block_external: z.boolean().default(false).describe("Abort requests to third-party hosts"),
    throttle_raf: z.number().int().min(1).max(60).optional().describe("Limit requestAnimationFrame callbacks to this many frames per second"),
  },
  handler: async (args, ctx) => {
    // Reserve 500 ms of a client budget for partial-state collection and returning the response.
    const budgetMs = Math.max(1, (ctx.callBudgetMs ?? 30000) - (ctx.callBudgetMs ? 1000 : 0));
    const deadline = Date.now() + budgetMs;
    const remaining = () => Math.max(1, deadline - Date.now());
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
    let page: Page | null = null;
    let budgetExpired = false;
    const consoleMessages: Array<{ type: string; text: string; location?: string }> = [];
    const pageErrors: string[] = [];
    const failedRequests: Array<{ url: string; status?: number; error?: string }> = [];
    const warnings: string[] = [];
    const stubUses = new Set<string>();
    const inFlightRequests = new Set<string>();
    const buildResult = (title: string, url: string, screenshot?: string) => {
      const sortedConsole = [...consoleMessages].sort((a, b) => {
        const score = (t: string) => (t === "error" ? 0 : t === "warning" ? 1 : 2);
        return score(a.type) - score(b.type);
      });
      const totalErrors = pageErrors.length + consoleMessages.filter((c) => c.type === "error").length;
      const parts: string[] = [];
      if (totalErrors > 0) parts.push(`${totalErrors} console error${totalErrors === 1 ? "" : "s"}`);
      if (failedRequests.length > 0) parts.push(`${failedRequests.length} failed request${failedRequests.length === 1 ? "" : "s"}`);
      let summary = parts.length ? `${parts.join(", ")} on ${url}` : `Loaded ${url} with 0 errors`;
      if (warnings.length) summary += `; ${warnings.join("; ")}`;
      if (stubUses.size) summary += `; browser API stubs used: ${[...stubUses].join(", ")}`;
      return {
        ok: true as const,
        tool: "browser_check",
        summary,
        data: {
          title, url, console: sortedConsole, pageErrors, failedRequests, warnings,
          browserApiStubsUsed: [...stubUses],
          browserApiStubsAvailable: ["requestPointerLock", "exitPointerLock", "requestFullscreen"],
        },
        ...(screenshot ? { images: [{ data: screenshot, mimeType: "image/png" }] } : {}),
      };
    };
    const collectStubUses = async (timeoutMs: number) => {
      if (!page || page.isClosed()) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const names = await Promise.race([
        page.evaluate(() => (window as any).__browserCheckStubUses ?? []).catch(() => [] as string[]),
        new Promise<string[]>((resolve) => { timer = setTimeout(() => resolve([]), Math.max(1, timeoutMs)); }),
      ]);
      if (timer) clearTimeout(timer);
      for (const name of names) stubUses.add(name);
    };

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

      const isLocalHost = (hostname: string) => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname.toLowerCase());
      const isThirdParty = (url: string) => {
        try {
          const req = new URL(url);
          const target = new URL(targetUrl!);
          return req.origin !== target.origin && !isLocalHost(req.hostname);
        } catch {
          return false;
        }
      };

      const resultPromise = (async () => {
          browser = await chromium.launch({
            executablePath: chromiumPath,
            headless: true,
            args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
            // HOME may be unwritable inside the container (e.g. the herdr override maps it to a
            // root-owned mount point); Chromium's profile and crashpad need a writable home.
            env: { ...process.env, ...chromiumHomeEnv() },
          });
          if (budgetExpired) {
            await browser.close().catch(() => undefined);
            browser = null;
            throw new Error("browser_check call budget elapsed during browser launch");
          }

          const isMobile = args.viewport === "mobile";
          const context = await browser.newContext(
            isMobile
              ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
              : { viewport: { width: 1280, height: 800 } }
          );

          page = await context.newPage();
          const rafFps = JSON.stringify(args.throttle_raf ?? null);
          await page.addInitScript({ content: `(() => {
            const fps = ${rafFps};
            window.__browserCheckStubUses = [];
            const mark = (name) => { if (!window.__browserCheckStubUses.includes(name)) window.__browserCheckStubUses.push(name); };
            const requestPointerLockStub = function () {
              mark("requestPointerLock");
              try { Object.defineProperty(document, "pointerLockElement", { configurable: true, value: this }); } catch (_) {}
              document.dispatchEvent(new Event("pointerlockchange"));
              return Promise.resolve();
            };
            const requestFullscreenStub = function () { mark("requestFullscreen"); return Promise.resolve(); };
            Object.defineProperty(Element.prototype, "requestPointerLock", { configurable: true, writable: true, value: requestPointerLockStub });
            Object.defineProperty(Element.prototype, "requestFullscreen", { configurable: true, writable: true, value: requestFullscreenStub });
            Object.defineProperty(Document.prototype, "exitPointerLock", {
              configurable: true, writable: true,
              value: function () {
                mark("exitPointerLock");
                try { Object.defineProperty(document, "pointerLockElement", { configurable: true, value: null }); } catch (_) {}
                document.dispatchEvent(new Event("pointerlockchange"));
              }
            });
            if (fps) {
              const nativeRaf = window.requestAnimationFrame.bind(window);
              const nativeCancel = window.cancelAnimationFrame.bind(window);
              const interval = 1000 / fps;
              let last = 0, nextId = 1;
              const timers = new Map();
              window.requestAnimationFrame = (callback) => {
                const id = nextId++;
                const delay = Math.max(0, interval - (performance.now() - last));
                const timer = window.setTimeout(() => {
                  last = performance.now(); timers.delete(id);
                  nativeRaf((time) => callback(time));
                }, delay);
                timers.set(id, timer);
                return id;
              };
              window.cancelAnimationFrame = (id) => {
                const timer = timers.get(id);
                if (timer !== undefined) window.clearTimeout(timer);
                timers.delete(id); nativeCancel(id);
              };
            }
          })()` });

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

          page.on("pageerror", (err) => {
            pageErrors.push(err.message || String(err));
          });

          const intentionallyAborted = new Set<string>();
          page.on("request", (req) => { if (!req.url().endsWith("/favicon.ico")) inFlightRequests.add(req.url()); });
          page.on("requestfinished", (req) => inFlightRequests.delete(req.url()));
          page.on("requestfailed", (req) => {
            inFlightRequests.delete(req.url());
            if (req.url().endsWith("/favicon.ico")) return;
            if (intentionallyAborted.has(req.url())) return;
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

          await page.route("**/*", async (route) => {
            const url = route.request().url();
            if (!isThirdParty(url)) return route.continue();
            if (args.block_external) {
              intentionallyAborted.add(url);
              warnings.push(`Blocked third-party request: ${url}`);
              return route.abort();
            }
            try {
              const response = await route.fetch({ timeout: Math.min(2000, remaining()) });
              return route.fulfill({ response });
            } catch {
              intentionallyAborted.add(url);
              warnings.push(`Aborted slow third-party request (> 2 s): ${url}`);
              return route.abort();
            }
          });

          await page.goto(targetUrl, { timeout: remaining(), waitUntil: "domcontentloaded" });
          try {
            await page.waitForLoadState("load", { timeout: Math.min(3000, remaining()) });
          } catch {
            const pending = [...inFlightRequests].slice(0, 3);
            warnings.push(`page 'load' did not finish (pending: ${pending.length ? pending.join(", ") : "unknown requests"})`);
          }
          // Execute optional actions
          if (args.actions && args.actions.length > 0) {
            for (const action of args.actions) {
              if (action.type === "click" && action.selector) {
                try {
                  await page.locator(action.selector).click({ timeout: Math.min(3000, remaining()), noWaitAfter: true });
                } catch (err) {
                  if (!/timeout|waiting for/i.test(String(err))) throw err;
                  await page.locator(action.selector).click({ timeout: Math.min(3000, remaining()), noWaitAfter: true, force: true });
                  warnings.push(`Retried click on ${action.selector} with force:true after actionability timeout`);
                }
              } else if (action.type === "type" && action.selector && action.text !== undefined) {
                try {
                  await page.locator(action.selector).fill(action.text, { timeout: Math.min(3000, remaining()), noWaitAfter: true });
                } catch (err) {
                  if (!/timeout|waiting for/i.test(String(err))) throw err;
                  await page.locator(action.selector).fill(action.text, { timeout: Math.min(3000, remaining()), noWaitAfter: true, force: true });
                  warnings.push(`Retried fill on ${action.selector} with force:true after actionability timeout`);
                }
              } else if (action.type === "press") {
                if (action.selector && action.key) {
                  await page.locator(action.selector).press(action.key, { timeout: Math.min(3000, remaining()), noWaitAfter: true });
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
            await page.waitForTimeout(Math.min(waitMs, remaining()));
          }

          const title = await page.title();
          const finalUrl = page.url();

          // Screenshot with ~1 MB cap
          let base64Data: string | undefined;
          try {
            let screenshotBuffer = await page.screenshot({
              fullPage: Boolean(args.full_page),
              type: "png",
              timeout: Math.min(3000, remaining()),
            });
            if (screenshotBuffer.length > 1_000_000 && args.full_page) {
              screenshotBuffer = await page.screenshot({
                fullPage: false,
                type: "png",
                timeout: Math.min(3000, remaining()),
              });
            }
            base64Data = screenshotBuffer.toString("base64");
          } catch (err) {
            warnings.push(`Screenshot unavailable: ${trimChromiumError(err)}`);
          }

          // Sort console messages: errors first, then warnings, then others
          await collectStubUses(remaining());
          return buildResult(title, finalUrl, base64Data);
        })();

      let budgetTimer: ReturnType<typeof setTimeout> | undefined;
      const budgetResult = new Promise<ReturnType<typeof buildResult>>((resolve) => {
        budgetTimer = setTimeout(async () => {
          budgetExpired = true;
          warnings.push(`browser_check stopped at its ${budgetMs} ms call budget`);
          let screenshot: string | undefined;
          if (page && !page.isClosed()) {
            try { screenshot = (await page.screenshot({ type: "png", timeout: 250 })).toString("base64"); } catch { /* partial result still useful */ }
            await collectStubUses(100);
          }
          let title = "";
          if (page && !page.isClosed()) {
            title = await Promise.race([
              page.title().catch(() => ""),
              new Promise<string>((resolve) => setTimeout(() => resolve(""), 100)),
            ]);
          }
          resolve(buildResult(title, page?.url() ?? targetUrl!, screenshot));
        }, remaining());
      });
      const result = await Promise.race([resultPromise, budgetResult]);
      if (budgetTimer) clearTimeout(budgetTimer);
      return result;
    } catch (err) {
      return fail("browser_check", trimChromiumError(err));
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
