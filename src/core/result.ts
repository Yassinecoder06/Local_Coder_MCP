/** SHARED CONTRACT — result envelope helpers. */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ToolResult } from "./types.js";

export function ok<T>(tool: string, summary: string, data?: T): ToolResult<T> {
  return { ok: true, tool, summary, data };
}

export function fail(tool: string, error: unknown, data?: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, tool, summary: message, error: message, data };
}

/** MCP output schema advertised for every native tool. */
export const RESULT_OUTPUT_SCHEMA = {
  ok: z.boolean(),
  tool: z.string(),
  summary: z.string(),
  data: z.unknown().optional(),
  error: z.string().optional(),
};

/**
 * Convert to the MCP wire format. Text content carries the full JSON so clients
 * that ignore structuredContent (Gemini) still see the data.
 */
export function toCallToolResult(withImages: ToolResult, maxBytes: number): CallToolResult {
  const { images, ...result } = withImages;
  let text = JSON.stringify(result);
  if (text.length > maxBytes) {
    text = JSON.stringify({ ...result, data: "[truncated — narrow the request]", truncated: true }).slice(0, maxBytes);
  }
  return {
    content: [{ type: "text", text }, ...(images ?? []).map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }))],
    structuredContent: result as unknown as Record<string, unknown>,
    isError: !result.ok,
  };
}
