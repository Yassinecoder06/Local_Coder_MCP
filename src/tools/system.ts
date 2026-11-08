import { detectIntegrations } from "../core/integrations.js";
import { z } from "zod";
import { defineTool, type ToolModule } from "../core/types.js";
import { ok, fail } from "../core/result.js";

function htmlToReadableText(html: string): string {
  let text = html;

  // Remove scripts, styles, svg, and metadata tags
  text = text.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ");
  text = text.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ");
  text = text.replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, " ");
  text = text.replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, " ");
  text = text.replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, " ");
  text = text.replace(/<header\b[^<]*(?:(?!<\/header>)<[^<]*)*<\/header>/gi, " ");
  text = text.replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, " ");

  // Headings
  text = text.replace(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/gi, "\n\n# $1\n");

  // Links: <a href="...">text</a> -> [text](href)
  text = text.replace(/<a\b[^>]*href=["']([^"']*)["'][^>]*>(.*?)<\/a>/gi, " [$2]($1) ");

  // List items
  text = text.replace(/<li[^>]*>(.*?)<\/li>/gi, "\n* $1");

  // Paragraphs and block elements
  text = text.replace(/<\/(p|div|section|article|blockquote|tr)>/gi, "\n\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");

  // Strip all other HTML tags
  text = text.replace(/<[^>]+>/g, " ");

  // Decode common HTML entities
  text = text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–");

  // Clean up whitespace: collapse multiple empty lines and excessive spaces
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line, i, arr) => line.length > 0 || (i > 0 && arr[i - 1].length > 0))
    .join("\n")
    .trim();
}

export const fetchUrlTool = defineTool({
  name: "fetch_url",
  title: "Fetch URL",
  description: "HTTP GET documentation or API specifications from a URL converted to readable text. Fetch reference docs directly to avoid guessing APIs.",
  group: "system",
  risk: "read",
  input: {
    url: z.string().url().describe("HTTP/HTTPS URL to fetch"),
    max_bytes: z
      .number()
      .int()
      .min(1)
      .max(200_000)
      .default(50_000)
      .optional()
      .describe("Maximum bytes of text content to return (default 50000)"),
  },
  handler: async (args, _ctx) => {
    try {
      const maxBytes = args.max_bytes ?? 50_000;
      const res = await fetch(args.url, {
        signal: AbortSignal.timeout(20_000),
        headers: {
          "User-Agent": "LocalCoderMCP/1.0",
          Accept: "text/html,application/json,text/plain,*/*",
        },
      });

      if (!res.ok) {
        return fail("fetch_url", `HTTP error ${res.status} (${res.statusText}) fetching ${args.url}`, {
          status: res.status,
          statusText: res.statusText,
        });
      }

      const contentType = res.headers.get("content-type") ?? "";
      const rawText = await res.text();

      let content = rawText;
      if (contentType.includes("html") || rawText.trim().startsWith("<!DOCTYPE") || rawText.trim().startsWith("<html")) {
        content = htmlToReadableText(rawText);
      }

      let truncated = false;
      if (Buffer.byteLength(content, "utf-8") > maxBytes) {
        content = content.slice(0, maxBytes) + "\n... [truncated]";
        truncated = true;
      }

      return ok("fetch_url", `Fetched ${args.url} (${content.length} chars)`, {
        url: args.url,
        status: res.status,
        content_type: contentType,
        content,
        truncated,
      });
    } catch (err) {
      return fail("fetch_url", err);
    }
  },
});

export const statusTool = defineTool({
  name: "status",
  title: "Server Status",
  description: "Get server status: version, uptime, auth and approval mode, active workspace, and which integrations (herdr, browser) are available.",
  group: "system",
  risk: "read",
  input: {},
  handler: async (_args, ctx) => {
    try {
      const uptimeSec = Math.floor(process.uptime());
      const active = ctx.workspace.active();
      const integrations = await detectIntegrations();
      return ok("status", `Local Coder MCP v${ctx.config.version} (uptime: ${uptimeSec}s)`, {
        version: ctx.config.version,
        uptime_sec: uptimeSec,
        auth_mode: ctx.config.authMode,
        tool_profile: ctx.config.toolProfile,
        approval_mode: ctx.config.approvalMode,
        active_workspace: ctx.workspace.display(active),
        active_workspace_abs: active,
        workspace_roots: ctx.workspace.roots,
        data_dir: ctx.config.dataDir,
        integrations,
      });
    } catch (err) {
      return fail("status", err);
    }
  },
});

const tools: ToolModule = [fetchUrlTool, statusTool];
export default tools;
