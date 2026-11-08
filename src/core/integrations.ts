/**
 * Owned by agy1. Detects host integrations: herdr and Chromium browser.
 */
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface IntegrationStatus {
  available: boolean;
  detail: string;
}

export interface Integrations {
  herdr: IntegrationStatus;
  browser: IntegrationStatus;
}

export async function detectHerdr(timeoutMs = 3000): Promise<IntegrationStatus> {
  try {
    const { stdout } = await execFileAsync("herdr", ["status"], {
      timeout: timeoutMs,
      env: process.env,
    });
    const firstLine = stdout.trim().split("\n")[0]?.trim() || "running";
    return {
      available: true,
      detail: `herdr is active (${firstLine})`,
    };
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      return {
        available: false,
        detail: "herdr binary not found on PATH",
      };
    }
    if (err?.killed || err?.signal === "SIGTERM") {
      return {
        available: false,
        detail: `herdr status timed out after ${timeoutMs}ms`,
      };
    }
    return {
      available: false,
      detail: err?.message || "herdr status failed",
    };
  }
}

export function detectBrowser(): IntegrationStatus {
  const chromiumPath = process.env.CHROMIUM_PATH || "/usr/bin/chromium";
  if (fs.existsSync(chromiumPath)) {
    return {
      available: true,
      detail: chromiumPath,
    };
  }
  return {
    available: false,
    detail: `Chromium not found at ${chromiumPath}`,
  };
}

export async function detectIntegrations(): Promise<Integrations> {
  const [herdr, browser] = await Promise.all([
    detectHerdr(),
    Promise.resolve(detectBrowser()),
  ]);
  return { herdr, browser };
}
