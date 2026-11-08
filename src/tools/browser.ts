import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { defineTool, type ToolModule } from "../core/types.js";
import { fail, ok } from "../core/result.js";

const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;

function capture(chromiumPath: string, args: string[], timeoutMs: number, tempDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/env", [
      `HOME=${tempDir}`,
      `XDG_CONFIG_HOME=${path.join(tempDir, "config")}`,
      `XDG_CACHE_HOME=${path.join(tempDir, "cache")}`,
      chromiumPath,
      ...args,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Chromium exceeded ${timeoutMs} ms`));
    }, timeoutMs);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 8_000) stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Chromium exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
    });
  });
}

export const browserCheckTool = defineTool({
  name: "browser_check",
  title: "Check Page in Browser",
  description: "Open an HTTP or HTTPS page in headless Chromium and return a screenshot image. Use after UI changes to visually verify the rendered page.",
  group: "system",
  risk: "read",
  input: {
    url: z.string().url().describe("HTTP or HTTPS URL to open (localhost and local development ports are supported)"),
    width: z.number().int().min(320).max(3840).default(1280).optional().describe("Screenshot viewport width (default 1280)"),
    height: z.number().int().min(240).max(2160).default(800).optional().describe("Screenshot viewport height (default 800)"),
    wait_ms: z.number().int().min(0).max(15_000).default(1_000).optional().describe("Virtual time to allow client-side rendering (default 1000 ms)"),
    timeout_ms: z.number().int().min(1_000).max(60_000).default(30_000).optional().describe("Maximum time to wait for Chromium (default 30000 ms)"),
  },
  handler: async (args, ctx) => {
    let tempDir: string | undefined;
    try {
      const url = new URL(args.url);
      if (!(["http:", "https:"].includes(url.protocol))) {
        return fail("browser_check", "Only HTTP and HTTPS URLs can be opened");
      }
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "local-coder-browser-"));
      const screenshotPath = path.join(tempDir, "screenshot.png");
      const width = args.width ?? 1280;
      const height = args.height ?? 800;
      const timeoutMs = args.timeout_ms ?? 30_000;
      await capture(ctx.config.chromiumPath, [
        "--headless",
        "--no-sandbox",
        "--disable-gpu",
        "--no-first-run",
        "--disable-background-networking",
        "--hide-scrollbars",
        `--user-data-dir=${path.join(tempDir, "profile")}`,
        `--window-size=${width},${height}`,
        `--virtual-time-budget=${args.wait_ms ?? 1_000}`,
        `--screenshot=${screenshotPath}`,
        url.toString(),
      ], timeoutMs, tempDir);
      const screenshot = await fs.readFile(screenshotPath);
      if (screenshot.length > MAX_SCREENSHOT_BYTES) {
        return fail("browser_check", `Screenshot exceeds the ${MAX_SCREENSHOT_BYTES} byte limit`, { screenshot_bytes: screenshot.length });
      }
      const result = ok("browser_check", `Captured ${width}×${height} screenshot of ${url.toString()}`, {
        url: url.toString(),
        width,
        height,
        screenshot_bytes: screenshot.length,
      });
      result.images = [{ data: screenshot.toString("base64"), mimeType: "image/png" }];
      return result;
    } catch (err) {
      return fail("browser_check", err);
    } finally {
      if (tempDir) await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  },
});

const tools: ToolModule = [browserCheckTool];
export default tools;
