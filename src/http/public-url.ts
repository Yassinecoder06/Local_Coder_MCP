/**
 * Helper for resolving public base URLs and display hosts.
 * Supports auto-discovery via cloudflared quicktunnel metrics endpoint.
 */
import type { Request } from "express";
import type { AppConfig } from "../config.js";

let cachedTunnelUrl: string | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 30_000;

/**
 * Returns a user-friendly display host (e.g. localhost instead of 0.0.0.0 or ::).
 */
export function getDisplayHost(host: string): string {
  const h = (host || "").trim();
  if (!h || h === "0.0.0.0" || h === "::" || h === "[::]") {
    return "localhost";
  }
  return h;
}

/**
 * Returns the local base URL using the display host and published host port.
 */
export function getLocalBaseUrl(config: AppConfig): string {
  const host = getDisplayHost(config.host);
  return `http://${host}:${config.hostPort}`;
}

/**
 * Clears the cached quicktunnel URL (used for tests).
 */
export function clearPublicUrlCache(): void {
  cachedTunnelUrl = null;
  cachedAt = 0;
}

/**
 * Resolves the public base URL:
 * 1. If config.publicUrl is set, returns that.
 * 2. If config.tunnelMetricsUrl is set, queries <tunnelMetricsUrl>/quicktunnel,
 *    caches for 30s, and returns https://<hostname>.
 * 3. Otherwise returns null.
 */
export async function resolvePublicUrl(config: AppConfig): Promise<string | null> {
  if (config.publicUrl) {
    return config.publicUrl.replace(/\/+$/, "");
  }

  if (config.tunnelMetricsUrl) {
    const now = Date.now();
    if (cachedAt && now - cachedAt < CACHE_TTL_MS) {
      return cachedTunnelUrl;
    }

    try {
      const endpoint = `${config.tunnelMetricsUrl.replace(/\/+$/, "")}/quicktunnel`;
      const res = await fetch(endpoint, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const data = (await res.json()) as { hostname?: string; url?: string };
        const hostname = data.hostname || (data.url ? new URL(data.url).hostname : undefined);
        if (hostname) {
          const cleanHost = hostname.replace(/^https?:\/\//, "").replace(/\/+$/, "");
          cachedTunnelUrl = `https://${cleanHost}`;
          cachedAt = now;
          return cachedTunnelUrl;
        }
      }
    } catch {
      // Tunnel not ready or metrics endpoint unreachable
    }

    cachedTunnelUrl = null;
    cachedAt = now;
    return null;
  }

  return null;
}

/**
 * Returns the effective base URL for OAuth metadata and auth challenges.
 * Prefers the public URL (configured or auto-discovered), then falls back
 * to forwarded headers or request origin / local base URL.
 */
export async function getEffectiveBaseUrl(req: Request, config: AppConfig): Promise<string> {
  const publicUrl = await resolvePublicUrl(config);
  if (publicUrl) return publicUrl;

  const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol || "http";
  const hostHeader = (req.headers["x-forwarded-host"] as string) || req.get("host");
  if (hostHeader) {
    const [h, p] = hostHeader.split(":");
    const displayH = getDisplayHost(h);
    const hostWithPort = p ? `${displayH}:${p}` : displayH;
    return `${proto}://${hostWithPort}`;
  }

  return getLocalBaseUrl(config);
}
