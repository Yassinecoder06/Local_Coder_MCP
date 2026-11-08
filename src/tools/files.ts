import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { defineTool, type ToolModule } from "../core/types.js";
import { ok, fail } from "../core/result.js";
import { createCheckpoint, restoreCheckpoint, listCheckpoints } from "./lib/checkpoints.js";
import { parseMultiFilePatch, applyHunksToText } from "./lib/patch.js";

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  ".output",
  "coverage",
]);

export const readTool = defineTool({
  name: "read",
  title: "Read Files",
  description: "Read one or more files with numbered lines, optional line range offset/limit, and size caps.",
  group: "files",
  risk: "read",
  input: {
    paths: z.array(z.string()).optional().describe("1 or more file paths to read"),
    path: z.string().optional().describe("Single file path to read (alternative to paths)"),
    offset: z.number().int().min(1).optional().describe("Starting line number (1-based, default 1)"),
    limit: z.number().int().min(1).optional().describe("Maximum number of lines to read per file"),
  },
  handler: async (args, ctx) => {
    try {
      const targetPaths: string[] = [];
      if (args.paths && args.paths.length > 0) {
        targetPaths.push(...args.paths);
      } else if (args.path) {
        targetPaths.push(args.path);
      } else {
        return fail("read", "Either paths or path must be provided");
      }

      const offset = args.offset ?? 1;
      const limit = args.limit;
      const results: Array<{
        path: string;
        total_lines: number;
        offset: number;
        limit?: number;
        content: string;
      }> = [];

      let totalOutputChars = 0;
      const maxChars = ctx.config.maxOutputBytes;

      for (const p of targetPaths) {
        const absPath = ctx.workspace.resolve(p);
        const displayPath = ctx.workspace.display(absPath);

        let raw: string;
        try {
          raw = await fs.readFile(absPath, "utf-8");
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          results.push({
            path: displayPath,
            total_lines: 0,
            offset,
            content: `Error reading file: ${msg}`,
          });
          continue;
        }

        const lines = raw.split(/\r?\n/);
        const startIdx = Math.max(0, offset - 1);
        const endIdx = limit !== undefined ? Math.min(lines.length, startIdx + limit) : lines.length;
        const selected = lines.slice(startIdx, endIdx);

        const padWidth = String(endIdx).length;
        const numbered = selected.map((line, idx) => {
          const lineNum = String(startIdx + idx + 1).padStart(padWidth, " ");
          return `${lineNum} | ${line}`;
        });

        let fileContent = numbered.join("\n");
        if (totalOutputChars + fileContent.length > maxChars) {
          const remaining = Math.max(0, maxChars - totalOutputChars);
          fileContent = fileContent.slice(0, remaining) + "\n... [truncated to fit max output size]";
        }
        totalOutputChars += fileContent.length;

        results.push({
          path: displayPath,
          total_lines: lines.length,
          offset,
          limit,
          content: fileContent,
        });

        if (totalOutputChars >= maxChars) break;
      }

      return ok("read", `Read ${results.length} file(s)`, { files: results });
    } catch (err) {
      return fail("read", err);
    }
  },
});

export const listTool = defineTool({
  name: "list",
  title: "List Directory",
  description: "List directory tree with depth limit, ignoring node_modules, .git, and build artifacts.",
  group: "files",
  risk: "read",
  input: {
    path: z.string().optional().describe("Directory path (defaults to active workspace)"),
    depth: z.number().int().min(1).max(10).default(3).optional().describe("Maximum directory depth (default 3)"),
    show_hidden: z.boolean().default(false).optional().describe("Include hidden files/folders (default false)"),
  },
  handler: async (args, ctx) => {
    try {
      const rootDir = ctx.workspace.resolve(args.path);
      const maxDepth = args.depth ?? 3;
      const showHidden = args.show_hidden ?? false;

      interface FileEntry {
        path: string;
        name: string;
        type: "file" | "dir";
        size?: number;
      }

      const entries: FileEntry[] = [];

      async function walk(currentDir: string, currentDepth: number) {
        if (currentDepth > maxDepth) return;
        let dirents;
        try {
          dirents = await fs.readdir(currentDir, { withFileTypes: true });
        } catch {
          return;
        }

        dirents.sort((a, b) => {
          if (a.isDirectory() && !b.isDirectory()) return -1;
          if (!a.isDirectory() && b.isDirectory()) return 1;
          return a.name.localeCompare(b.name);
        });

        for (const dirent of dirents) {
          if (!showHidden && dirent.name.startsWith(".")) continue;
          if (dirent.isDirectory() && IGNORED_DIRS.has(dirent.name)) continue;

          const fullPath = path.join(currentDir, dirent.name);
          const relPath = ctx.workspace.display(fullPath);

          if (dirent.isDirectory()) {
            entries.push({ path: relPath, name: dirent.name, type: "dir" });
            await walk(fullPath, currentDepth + 1);
          } else if (dirent.isFile()) {
            let size: number | undefined;
            try {
              const stat = await fs.stat(fullPath);
              size = stat.size;
            } catch {
              // ignore
            }
            entries.push({ path: relPath, name: dirent.name, type: "file", size });
          }
        }
      }

      await walk(rootDir, 1);
      const displayRoot = ctx.workspace.display(rootDir);
      return ok("list", `Listed ${entries.length} items in ${displayRoot}`, {
        root: displayRoot,
        total: entries.length,
        entries,
      });
    } catch (err) {
      return fail("list", err);
    }
  },
});

export const writeTool = defineTool({
  name: "write",
  title: "Write File",
  description: "Create or overwrite a file (creates parent directories automatically). Checkpointed for undo.",
  group: "files",
  risk: "write",
  input: {
    path: z.string().describe("File path to create or overwrite"),
    content: z.string().describe("Full content of the file"),
  },
  handler: async (args, ctx) => {
    try {
      const absPath = ctx.workspace.resolve(args.path);
      const displayPath = ctx.workspace.display(absPath);

      const checkpointId = await createCheckpoint(
        ctx.config,
        "write",
        `write ${displayPath}`,
        [absPath]
      );

      await fs.mkdir(path.dirname(absPath), { recursive: true });
      await fs.writeFile(absPath, args.content, "utf-8");
      const bytes = Buffer.byteLength(args.content, "utf-8");

      return ok("write", `Wrote ${bytes} bytes to ${displayPath}`, {
        path: displayPath,
        bytes,
        checkpoint_id: checkpointId,
      });
    } catch (err) {
      return fail("write", err);
    }
  },
});

export const editTool = defineTool({
  name: "edit",
  title: "Edit File",
  description: "Apply 1 or more exact string replacements to a file. Checkpointed for undo.",
  group: "files",
  risk: "write",
  input: {
    path: z.string().describe("File path to edit"),
    edits: z
      .array(
        z.object({
          old: z.string().describe("Exact text to find and replace"),
          new: z.string().describe("Replacement text"),
          replace_all: z.boolean().default(false).optional().describe("Replace all occurrences (default false)"),
        })
      )
      .optional()
      .describe("List of exact string replacements"),
    old: z.string().optional().describe("Single edit old text (fallback)"),
    new: z.string().optional().describe("Single edit new text (fallback)"),
    replace_all: z.boolean().default(false).optional().describe("Single edit replace_all flag"),
  },
  handler: async (args, ctx) => {
    try {
      const absPath = ctx.workspace.resolve(args.path);
      const displayPath = ctx.workspace.display(absPath);

      const editList: Array<{ old: string; new: string; replace_all?: boolean }> = [];
      if (args.edits && args.edits.length > 0) {
        editList.push(...args.edits);
      } else if (args.old !== undefined && args.new !== undefined) {
        editList.push({ old: args.old, new: args.new, replace_all: args.replace_all });
      } else {
        return fail("edit", "Either edits array or old/new strings must be provided");
      }

      let content = await fs.readFile(absPath, "utf-8");

      const checkpointId = await createCheckpoint(
        ctx.config,
        "edit",
        `edit ${displayPath} (${editList.length} replacement(s))`,
        [absPath]
      );

      let totalReplacements = 0;

      for (let i = 0; i < editList.length; i++) {
        const edit = editList[i];
        if (!content.includes(edit.old)) {
          const preview = edit.old.length > 80 ? edit.old.slice(0, 80) + "..." : edit.old;
          throw new Error(`Edit #${i + 1} failed: exact text not found in ${displayPath}: "${preview}"`);
        }

        if (edit.replace_all) {
          const occurrences = content.split(edit.old).length - 1;
          content = content.replaceAll(edit.old, edit.new);
          totalReplacements += occurrences;
        } else {
          const idx = content.indexOf(edit.old);
          content = content.slice(0, idx) + edit.new + content.slice(idx + edit.old.length);
          totalReplacements += 1;
        }
      }

      await fs.writeFile(absPath, content, "utf-8");

      return ok("edit", `Applied ${editList.length} edit(s) (${totalReplacements} replacement(s)) to ${displayPath}`, {
        path: displayPath,
        edits_count: editList.length,
        total_replacements: totalReplacements,
        checkpoint_id: checkpointId,
      });
    } catch (err) {
      return fail("edit", err);
    }
  },
});

export const applyPatchTool = defineTool({
  name: "apply_patch",
  title: "Apply Patch",
  description: "Apply a multi-file patch (supporting '*** Begin Patch' format and unified diffs). Checkpointed for undo.",
  group: "files",
  risk: "write",
  input: {
    patch: z.string().describe("Patch in '*** Begin Patch' format or standard unified diff"),
  },
  handler: async (args, ctx) => {
    try {
      const ops = parseMultiFilePatch(args.patch);
      if (ops.length === 0) {
        throw new Error("No file operations or hunks found in patch");
      }

      const affectedPaths = new Set<string>();
      for (const op of ops) {
        affectedPaths.add(ctx.workspace.resolve(op.path));
        if (op.destPath) {
          affectedPaths.add(ctx.workspace.resolve(op.destPath));
        }
      }

      const checkpointId = await createCheckpoint(
        ctx.config,
        "apply_patch",
        `apply patch across ${ops.length} file(s)`,
        Array.from(affectedPaths)
      );

      const results: Array<{ path: string; operation: string; ok: boolean; error?: string }> = [];

      for (const op of ops) {
        const absPath = ctx.workspace.resolve(op.path);
        const displayPath = ctx.workspace.display(absPath);

        try {
          if (op.operation === "delete") {
            await fs.rm(absPath, { recursive: true, force: true });
            results.push({ path: displayPath, operation: "delete", ok: true });
          } else if (op.operation === "create") {
            await fs.mkdir(path.dirname(absPath), { recursive: true });
            await fs.writeFile(absPath, op.content ?? "", "utf-8");
            results.push({ path: displayPath, operation: "create", ok: true });
          } else if (op.operation === "move") {
            if (!op.destPath) throw new Error(`Destination path required for move operation on ${displayPath}`);
            const destAbs = ctx.workspace.resolve(op.destPath);
            const destDisplay = ctx.workspace.display(destAbs);

            await fs.mkdir(path.dirname(destAbs), { recursive: true });
            if (op.hunks && op.hunks.length > 0) {
              const original = await fs.readFile(absPath, "utf-8");
              const modified = applyHunksToText(original, op.hunks);
              await fs.writeFile(destAbs, modified, "utf-8");
              await fs.rm(absPath, { force: true });
            } else {
              await fs.rename(absPath, destAbs);
            }
            results.push({ path: `${displayPath} -> ${destDisplay}`, operation: "move", ok: true });
          } else if (op.operation === "update") {
            const original = await fs.readFile(absPath, "utf-8");
            const modified = applyHunksToText(original, op.hunks ?? []);
            await fs.writeFile(absPath, modified, "utf-8");
            results.push({ path: displayPath, operation: "update", ok: true });
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          results.push({ path: displayPath, operation: op.operation, ok: false, error: msg });
          // If any operation fails, restore checkpoint and fail the whole patch
          if (checkpointId) {
            await restoreCheckpoint(ctx.config, checkpointId).catch(() => {});
          }
          throw new Error(`Patch failed on ${displayPath}: ${msg}`);
        }
      }

      return ok("apply_patch", `Successfully applied patch to ${results.length} file(s)`, {
        results,
        checkpoint_id: checkpointId,
      });
    } catch (err) {
      return fail("apply_patch", err);
    }
  },
});

export const fileOpsTool = defineTool({
  name: "file_ops",
  title: "File Operations",
  description: "Batch move, copy, delete, or create directories. Checkpointed for undo.",
  group: "files",
  risk: "write",
  input: {
    operations: z
      .array(
        z.object({
          op: z.enum(["move", "copy", "delete", "mkdir"]).describe("Operation type"),
          src: z.string().optional().describe("Source path for move/copy"),
          dest: z.string().optional().describe("Destination path for move/copy"),
          path: z.string().optional().describe("Target path for delete/mkdir"),
        })
      )
      .min(1)
      .describe("Batch of file operations"),
  },
  handler: async (args, ctx) => {
    try {
      const affectedPaths = new Set<string>();

      for (const item of args.operations) {
        if (item.op === "move" || item.op === "copy") {
          if (!item.src || !item.dest) throw new Error(`Both src and dest are required for ${item.op}`);
          affectedPaths.add(ctx.workspace.resolve(item.src));
          affectedPaths.add(ctx.workspace.resolve(item.dest));
        } else if (item.op === "delete" || item.op === "mkdir") {
          const target = item.path || item.src;
          if (!target) throw new Error(`path is required for ${item.op}`);
          affectedPaths.add(ctx.workspace.resolve(target));
        }
      }

      const checkpointId = await createCheckpoint(
        ctx.config,
        "file_ops",
        `file_ops: ${args.operations.map((o) => o.op).join(", ")}`,
        Array.from(affectedPaths)
      );

      const results: Array<{ op: string; target: string; ok: boolean }> = [];

      for (const item of args.operations) {
        if (item.op === "move") {
          const srcAbs = ctx.workspace.resolve(item.src!);
          const destAbs = ctx.workspace.resolve(item.dest!);
          await fs.mkdir(path.dirname(destAbs), { recursive: true });
          await fs.rename(srcAbs, destAbs);
          results.push({ op: "move", target: `${ctx.workspace.display(srcAbs)} -> ${ctx.workspace.display(destAbs)}`, ok: true });
        } else if (item.op === "copy") {
          const srcAbs = ctx.workspace.resolve(item.src!);
          const destAbs = ctx.workspace.resolve(item.dest!);
          await fs.mkdir(path.dirname(destAbs), { recursive: true });
          await fs.cp(srcAbs, destAbs, { recursive: true });
          results.push({ op: "copy", target: `${ctx.workspace.display(srcAbs)} -> ${ctx.workspace.display(destAbs)}`, ok: true });
        } else if (item.op === "delete") {
          const targetAbs = ctx.workspace.resolve((item.path || item.src)!);
          await fs.rm(targetAbs, { recursive: true, force: true });
          results.push({ op: "delete", target: ctx.workspace.display(targetAbs), ok: true });
        } else if (item.op === "mkdir") {
          const targetAbs = ctx.workspace.resolve((item.path || item.src)!);
          await fs.mkdir(targetAbs, { recursive: true });
          results.push({ op: "mkdir", target: ctx.workspace.display(targetAbs), ok: true });
        }
      }

      return ok("file_ops", `Completed ${results.length} file operation(s)`, {
        results,
        checkpoint_id: checkpointId,
      });
    } catch (err) {
      return fail("file_ops", err);
    }
  },
});

export const undoTool = defineTool({
  name: "undo",
  title: "Undo Checkpoint",
  description: "List recent checkpoints or restore files to a previous checkpoint snapshot.",
  group: "files",
  risk: "write",
  input: {
    checkpoint_id: z.string().optional().describe("Checkpoint ID to restore. If omitted, lists recent checkpoints."),
    limit: z.number().int().min(1).max(50).default(10).optional().describe("Max checkpoints to list when checkpoint_id is omitted"),
  },
  handler: async (args, ctx) => {
    try {
      if (!args.checkpoint_id) {
        const checkpoints = await listCheckpoints(ctx.config, args.limit ?? 10);
        return ok("undo", `Found ${checkpoints.length} checkpoint(s)`, { checkpoints });
      }

      const result = await restoreCheckpoint(ctx.config, args.checkpoint_id);
      return ok("undo", `Restored checkpoint ${result.id} (${result.restoredFiles.length} file(s))`, {
        checkpoint_id: result.id,
        restored_files: result.restoredFiles.map((p) => ctx.workspace.display(p)),
      });
    } catch (err) {
      return fail("undo", err);
    }
  },
});

const tools: ToolModule = [readTool, listTool, writeTool, editTool, applyPatchTool, fileOpsTool, undoTool];
export default tools;
