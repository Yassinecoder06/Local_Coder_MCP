/**
 * SHARED CONTRACT — maps tool risk to MCP annotations.
 *
 * ChatGPT and Gemini decide whether to show a confirmation ("Allow / Always allow")
 * from these hints: readOnlyHint=true tools run without asking; open-world or
 * destructive tools always ask. In `minimal` mode write/exec tools are marked
 * closed-world and non-destructive (they only touch the user's own sandboxed
 * workspace, and every file edit is checkpointed and undoable), which keeps
 * prompts to a single first-use approval per tool.
 */
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { ToolRisk } from "./types.js";

export function annotationsFor(risk: ToolRisk, title: string, mode: "minimal" | "standard"): ToolAnnotations {
  if (risk === "read") {
    return { title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  }
  if (mode === "minimal") {
    return { title, readOnlyHint: false, destructiveHint: false, idempotentHint: risk === "write", openWorldHint: false };
  }
  return { title, readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: risk === "exec" };
}
