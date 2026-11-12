/**
 * Owned by agy2. Human-in-the-loop and verification tools (ask_user, user_request_status, finish).
 *
 * NOTE: These tools allow the assistant to coordinate with the user on steps that must be
 * run manually, inspect manual step status without reading file contents, and report task completion
 * with verified evidence.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { defineTool, type ToolModule } from "../core/types.js";
import { ok, fail } from "../core/result.js";
import { collectFinishEvidence } from "./lib/evidence.js";

function isInsideWorkspaceRoots(target: string, roots: string[]): boolean {
  const absTarget = path.resolve(target);
  return roots.some((r) => {
    const absRoot = path.resolve(r);
    return absTarget === absRoot || absTarget.startsWith(absRoot.endsWith(path.sep) ? absRoot : absRoot + path.sep);
  });
}

export const askUserTool = defineTool({
  name: "ask_user",
  title: "Ask Person to Run Command",
  description:
    "Ask the person to run one command on their machine. It never runs anything itself; never use it for an action you declined or that was refused for safety. The person will see a card with Copy, Mark done, and Skip in the admin UI. Use user_request_status to check whether the request was completed.",
  group: "workspace",
  risk: "read",
  input: {
    command: z
      .string()
      .describe("Exact shell command for the person to execute on their machine (never executed by the server)"),
    cwd: z
      .string()
      .optional()
      .describe("Working directory for the command (must resolve inside a workspace root; defaults to active workspace root)"),
    purpose: z
      .string()
      .describe("One-line reason explaining why the person needs to run this command"),
    expected_files: z
      .array(z.string())
      .max(10)
      .optional()
      .describe("Up to 10 file paths the step should produce or update (must resolve inside a workspace root)"),
    constraints: z
      .string()
      .optional()
      .describe("Optional constraints or special instructions for the person"),
  },
  handler: async (args, ctx) => {
    try {
      if (!ctx.board) {
        return fail("ask_user", "Board service is not available in context");
      }

      const command = args.command.trim();
      if (!command) {
        return fail("ask_user", "command is required");
      }

      const activeWorkspace = ctx.workspace.active();

      // Resolve and validate cwd
      let resolvedCwd = activeWorkspace;
      if (args.cwd && args.cwd.trim().length > 0) {
        resolvedCwd = ctx.workspace.resolve(args.cwd.trim());
      }
      if (!isInsideWorkspaceRoots(resolvedCwd, ctx.workspace.roots)) {
        return fail("ask_user", `cwd must resolve inside a workspace root: ${resolvedCwd}`);
      }

      // Resolve and validate expected_files
      const expectedFiles: string[] = [];
      if (args.expected_files && args.expected_files.length > 0) {
        if (args.expected_files.length > 10) {
          return fail("ask_user", "at most 10 expected files allowed");
        }
        for (const f of args.expected_files) {
          const resolvedFile = ctx.workspace.resolve(f.trim());
          if (!isInsideWorkspaceRoots(resolvedFile, ctx.workspace.roots)) {
            return fail("ask_user", `expected file path outside workspace: ${resolvedFile}`);
          }
          expectedFiles.push(resolvedFile);
        }
      }

      const req = await ctx.board.addRequest({
        workspace: activeWorkspace,
        command,
        cwd: resolvedCwd,
        purpose: args.purpose,
        expectedFiles,
        constraints: args.constraints,
      });

      const summary = `Request ${req.id}: The person will see a card with Copy / Mark done / Skip. Call user_request_status later; do not run this command yourself.`;

      return ok("ask_user", summary, {
        id: req.id,
        status: req.status,
        command: req.command,
        cwd: req.cwd,
        purpose: req.purpose,
        expected_files: req.expectedFiles,
      });
    } catch (err) {
      return fail("ask_user", err);
    }
  },
});

export const userRequestStatusTool = defineTool({
  name: "user_request_status",
  title: "User Request Status",
  description:
    "Check status and expected files of user requests submitted via ask_user. Returns status, note, and file existence/size/mtime without reading file contents.",
  group: "workspace",
  risk: "read",
  input: {
    ids: z
      .array(z.string())
      .optional()
      .describe("Optional list of specific request IDs to inspect; defaults to all open and recently closed requests in the active workspace"),
  },
  handler: async (args, ctx) => {
    try {
      if (!ctx.board) {
        return fail("user_request_status", "Board service is not available in context");
      }

      const activeWorkspace = ctx.workspace.active();
      let rawRequests = await ctx.board.listRequests({ workspace: activeWorkspace });

      if (args.ids && args.ids.length > 0) {
        const idSet = new Set(args.ids);
        rawRequests = rawRequests.filter((r) => idSet.has(r.id));
        // If an explicit ID was requested but not in this workspace, try getRequest directly
        for (const id of args.ids) {
          if (!rawRequests.some((r) => r.id === id)) {
            const req = await ctx.board.getRequest(id);
            if (req) rawRequests.push(req);
          }
        }
      }

      const requests = await Promise.all(
        rawRequests.map(async (r) => {
          const files = await Promise.all(
            (r.expectedFiles ?? []).map(async (filePath) => {
              try {
                const st = await fs.stat(filePath);
                return {
                  path: filePath,
                  exists: true,
                  size: st.size,
                  mtime: st.mtime.toISOString(),
                };
              } catch {
                return {
                  path: filePath,
                  exists: false,
                };
              }
            })
          );

          return {
            id: r.id,
            status: r.status,
            command: r.command,
            cwd: r.cwd,
            purpose: r.purpose,
            note: r.note,
            expected_files: files,
            createdAt: r.createdAt,
            updatedAt: r.updatedAt,
          };
        })
      );

      const openCount = requests.filter((r) => r.status === "open").length;
      const doneCount = requests.filter((r) => r.status === "done").length;
      const skippedCount = requests.filter((r) => r.status === "skipped").length;
      const summary = `${requests.length} user request(s) (${openCount} open, ${doneCount} done, ${skippedCount} skipped)`;

      return ok("user_request_status", summary, {
        requests,
      });
    } catch (err) {
      return fail("user_request_status", err);
    }
  },
});

export const finishTool = defineTool({
  name: "finish",
  title: "Finish Task & Verification",
  description:
    "Submit task completion report with verification evidence from recent activity, tests, and git status. Marks verified only if recent verification passed after the last edits with no open requests.",
  group: "workspace",
  risk: "read",
  input: {
    summary: z
      .string()
      .describe("Summary of what was accomplished and verified in this task"),
    changed_files: z
      .array(z.string())
      .optional()
      .describe("Optional list of files modified during this task"),
  },
  handler: async (args, ctx) => {
    try {
      if (!ctx.board) {
        return fail("finish", "Board service is not available in context");
      }

      const activeWorkspace = ctx.workspace.active();
      const { evidence, verified, warnings } = await collectFinishEvidence(ctx, activeWorkspace);

      const changedFiles = (args.changed_files ?? []).map((f) => ctx.workspace.resolve(f));

      const report = await ctx.board.addFinish({
        workspace: activeWorkspace,
        summary: args.summary,
        changedFiles,
        evidence,
        verified,
        warnings,
      });

      const summaryText = verified
        ? `Task completed and verified (id: ${report.id}): ${args.summary}${warnings.length > 0 ? ` (warnings: ${warnings.join("; ")})` : ""}`
        : `Task finish recorded (id: ${report.id}) but NOT verified: ${warnings.join("; ")}`;

      return ok("finish", summaryText, {
        report,
        verified,
        warnings,
      });
    } catch (err) {
      return fail("finish", err);
    }
  },
});

const tools: ToolModule = [askUserTool, userRequestStatusTool, finishTool];
export default tools;
