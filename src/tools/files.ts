import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { defineTool, type ToolModule } from "../core/types.js";
import { ok, fail } from "../core/result.js";
import { createCheckpoint, restoreCheckpoint, listCheckpoints } from "./lib/checkpoints.js";
import { parseMultiFilePatch, parseHunks, applyHunksToText } from "./lib/patch.js";
import { runDiagnostics } from "./lib/diagnostics.js";

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

export const DEFAULT_MAX_FILE_BYTES = 256 * 1024; // 256 KB
export const DEFAULT_MAX_CALL_BYTES = 512 * 1024; // 512 KB
export const MAX_EXPANDED_GLOB_FILES = 50;
const GLOB_CHARS_RE = /[*?{}[\]]/;

export const readTool = defineTool({
  name: "read",
  title: "Read Files",
  description:
    "Read 1 to N files or directory listings with glob expansion and numbered lines. Always batch multiple file paths in a single call to minimize confirmations.",
  group: "files",
  risk: "read",
  input: {
    paths: z
      .array(z.string())
      .default([])
      .optional()
      .describe(
        "List of file paths, directory paths, or glob patterns to read (max 50 files). Batch multiple paths in one call to avoid extra confirmation prompts."
      ),
    path: z
      .string()
      .optional()
      .describe("Single file path, directory path, or glob pattern to read"),
    offset: z.number().int().min(1).optional().describe("Starting line number (1-based, default 1)"),
    limit: z.number().int().min(1).optional().describe("Maximum number of lines to read per file or directory"),
  },
  handler: async (args, ctx) => {
    try {
      const rawPaths: string[] = [];
      if (args.paths && args.paths.length > 0) {
        rawPaths.push(...args.paths);
      } else if (args.path) {
        rawPaths.push(args.path);
      } else {
        return fail("read", "Either paths or path must be provided");
      }

      const activeDir = ctx.workspace.active();
      const isIgnored = (candidate: string) => {
        const parts = candidate.split(/[/\\]/);
        return parts.some((part) => IGNORED_DIRS.has(part));
      };

      // Expand globs in paths (bounded, max 50 files, ignore node_modules/.git/dist)
      const targetPaths: string[] = [];
      for (const p of rawPaths) {
        if (GLOB_CHARS_RE.test(p)) {
          const matched: string[] = [];
          try {
            const globOptions = path.isAbsolute(p)
              ? { exclude: isIgnored }
              : { cwd: activeDir, exclude: isIgnored };

            for await (const entry of fs.glob(p, globOptions)) {
              matched.push(entry);
              if (targetPaths.length + matched.length >= MAX_EXPANDED_GLOB_FILES) {
                break;
              }
            }
          } catch {
            matched.push(p);
          }

          if (matched.length > 0) {
            targetPaths.push(...matched.sort());
          } else {
            targetPaths.push(p);
          }
        } else {
          targetPaths.push(p);
        }

        if (targetPaths.length >= MAX_EXPANDED_GLOB_FILES) {
          targetPaths.splice(MAX_EXPANDED_GLOB_FILES);
          break;
        }
      }

      const offset = args.offset ?? 1;
      const limit = args.limit;
      const results: Array<{
        path: string;
        type?: "file" | "directory";
        total_lines: number;
        offset: number;
        limit?: number;
        content: string;
      }> = [];

      let totalOutputChars = 0;
      const maxCallBytes = DEFAULT_MAX_CALL_BYTES;
      const maxFileBytes = DEFAULT_MAX_FILE_BYTES;

      for (const p of targetPaths) {
        const absPath = ctx.workspace.resolve(p);
        const displayPath = ctx.workspace.display(absPath);

        let stat: Awaited<ReturnType<typeof fs.stat>>;
        try {
          stat = await fs.stat(absPath);
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

        // Directory path: list one level deep
        if (stat.isDirectory()) {
          try {
            const dirEntries = await fs.readdir(absPath, { withFileTypes: true });
            dirEntries.sort((a, b) => {
              if (a.isDirectory() && !b.isDirectory()) return -1;
              if (!a.isDirectory() && b.isDirectory()) return 1;
              return a.name.localeCompare(b.name);
            });

            const padWidth = String(dirEntries.length || 1).length;
            const lines = dirEntries.map((e, idx) => {
              const lineNum = String(idx + 1).padStart(padWidth, " ");
              return `${lineNum} | ${e.name}${e.isDirectory() ? "/" : ""}`;
            });

            const startIdx = Math.max(0, offset - 1);
            const endIdx =
              limit !== undefined ? Math.min(lines.length, startIdx + limit) : lines.length;
            const selected = lines.slice(startIdx, endIdx);
            let dirContent = selected.length > 0 ? selected.join("\n") : "(empty directory)";

            if (totalOutputChars + dirContent.length > maxCallBytes) {
              const remaining = Math.max(0, maxCallBytes - totalOutputChars);
              dirContent =
                dirContent.slice(0, remaining) + "\n... [truncated to 512 KB per call limit]";
            }
            totalOutputChars += dirContent.length;

            results.push({
              path: displayPath,
              type: "directory",
              total_lines: dirEntries.length,
              offset,
              limit,
              content: dirContent,
            });
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            results.push({
              path: displayPath,
              type: "directory",
              total_lines: 0,
              offset,
              content: `Error reading directory: ${msg}`,
            });
          }

          if (totalOutputChars >= maxCallBytes) break;
          continue;
        }

        // Regular file read
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

        let fileTruncated = false;
        if (Buffer.byteLength(raw, "utf-8") > maxFileBytes) {
          raw = raw.slice(0, maxFileBytes);
          fileTruncated = true;
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
        if (fileTruncated) {
          fileContent += "\n... [truncated: file exceeded 256 KB limit]";
        }

        if (totalOutputChars + fileContent.length > maxCallBytes) {
          const remaining = Math.max(0, maxCallBytes - totalOutputChars);
          fileContent =
            fileContent.slice(0, remaining) + "\n... [truncated to 512 KB per call limit]";
          totalOutputChars = maxCallBytes;
        } else {
          totalOutputChars += fileContent.length;
        }

        results.push({
          path: displayPath,
          type: "file",
          total_lines: lines.length,
          offset,
          limit,
          content: fileContent,
        });

        if (totalOutputChars >= maxCallBytes) break;
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
  description: "List directory tree with depth limit, ignoring node_modules, .git, and build artifacts. Use to inspect project layout in one call.",
  group: "files",
  risk: "read",
  input: {
    path: z.string().optional().describe("Directory path to list (defaults to active workspace)"),
    depth: z.number().int().min(1).max(10).default(3).optional().describe("Maximum directory depth to traverse (default 3)"),
    show_hidden: z.boolean().default(false).optional().describe("Include hidden files and folders (default false)"),
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

export const checkpointsTool = defineTool({
  name: "checkpoints",
  title: "List Checkpoints",
  description: "List recent file edit checkpoints (ID, timestamp, tool, modified files) created by edit_files. Use to find checkpoint_id for undo.",
  group: "files",
  risk: "read",
  input: {
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .optional()
      .describe("Maximum number of recent checkpoints to return (default 10)"),
  },
  handler: async (args, ctx) => {
    try {
      const checkpoints = await listCheckpoints(ctx.config, args.limit ?? 10);
      return ok("checkpoints", `Found ${checkpoints.length} checkpoint(s)`, { checkpoints });
    } catch (err) {
      return fail("checkpoints", err);
    }
  },
});

const fileOperationSchema = z.object({
  op: z
    .enum(["write", "replace", "patch", "move", "copy", "delete", "mkdir", "undo"])
    .describe("Operation type: write (create/overwrite file), replace (exact text substitution), patch (unified or Begin Patch diff), move (rename), copy, delete, mkdir, or undo (restore checkpoint)"),
  path: z
    .string()
    .optional()
    .describe("Target file or directory path for write, replace, patch, move source, copy source, delete, or mkdir"),
  content: z
    .string()
    .optional()
    .describe("Full content to write for 'write' operation"),
  old: z
    .string()
    .optional()
    .describe("Exact text to match and replace for 'replace' operation"),
  new: z
    .string()
    .optional()
    .describe("Replacement text for 'replace' operation"),
  replace_all: z
    .boolean()
    .default(false)
    .optional()
    .describe("Replace all occurrences if true, first occurrence only if false for 'replace' operation (default false)"),
  patch: z
    .string()
    .optional()
    .describe("Patch content in unified diff or '*** Begin Patch' format for 'patch' operation"),
  to: z
    .string()
    .optional()
    .describe("Destination file or directory path for 'move' or 'copy' operation"),
  checkpoint_id: z
    .string()
    .optional()
    .describe("Checkpoint ID to restore for 'undo' operation"),
});

export const editFilesTool = defineTool({
  name: "edit_files",
  title: "Edit Files",
  description: "Create, edit, patch, move, copy, delete files or directories, or undo a checkpoint. Batch all changes into one call to avoid multiple confirmation prompts.",
  group: "files",
  risk: "write",
  input: {
    patch: z
      .string()
      .optional()
      .describe("Multi-file patch in '*** Begin Patch' format or standard unified diff (convenience shorthand for a patch operation)"),
    operations: z
      .array(fileOperationSchema)
      .default([])
      .optional()
      .describe("Array of file operations to execute sequentially in one batch. Always batch multiple file edits in a single call."),
    ops: z
      .array(fileOperationSchema)
      .optional()
      .describe("Alias for operations"),
  },
  handler: async (args, ctx) => {
    try {
      const opsList = [...(args.operations && args.operations.length > 0 ? args.operations : (args.ops ?? []))];
      if (args.patch) {
        opsList.unshift({ op: "patch", patch: args.patch });
      }

      if (opsList.length === 0) {
        return fail("edit_files", "Either operations array or top-level patch must be provided");
      }

      // Collect all affected paths before mutating so we can snapshot them
      const affectedPaths = new Set<string>();

      for (const op of opsList) {
        if (op.op === "undo") continue;

        if (op.op === "write" || op.op === "replace" || op.op === "delete" || op.op === "mkdir") {
          if (op.path) affectedPaths.add(ctx.workspace.resolve(op.path));
        } else if (op.op === "move" || op.op === "copy") {
          if (op.path) affectedPaths.add(ctx.workspace.resolve(op.path));
          if (op.to) affectedPaths.add(ctx.workspace.resolve(op.to));
        } else if (op.op === "patch") {
          const patchText = op.patch || op.content || "";
          const patchOps = parseMultiFilePatch(patchText);
          if (patchOps.length > 0) {
            for (const pOp of patchOps) {
              affectedPaths.add(ctx.workspace.resolve(pOp.path));
              if (pOp.destPath) affectedPaths.add(ctx.workspace.resolve(pOp.destPath));
            }
          } else if (op.path) {
            affectedPaths.add(ctx.workspace.resolve(op.path));
          }
        }
      }

      let checkpointId: string | undefined;
      if (affectedPaths.size > 0) {
        checkpointId = await createCheckpoint(
          ctx.config,
          "edit_files",
          `edit_files: ${opsList.map((o) => o.op).join(", ")}`,
          Array.from(affectedPaths),
          ctx.workspace.active()
        );
      }

      const results: Array<Record<string, unknown>> = [];

      try {
        for (let i = 0; i < opsList.length; i++) {
          const op = opsList[i];

          if (op.op === "write") {
            if (!op.path) throw new Error("path is required for 'write' operation");
            const absPath = ctx.workspace.resolve(op.path);
            const displayPath = ctx.workspace.display(absPath);
            await fs.mkdir(path.dirname(absPath), { recursive: true });
            const content = op.content ?? "";
            await fs.writeFile(absPath, content, "utf-8");
            const bytes = Buffer.byteLength(content, "utf-8");
            results.push({ op: "write", path: displayPath, bytes, ok: true });
          } else if (op.op === "replace") {
            if (!op.path) throw new Error("path is required for 'replace' operation");
            if (op.old === undefined) throw new Error("old text is required for 'replace' operation");
            const absPath = ctx.workspace.resolve(op.path);
            const displayPath = ctx.workspace.display(absPath);
            let fileContent = await fs.readFile(absPath, "utf-8");

            if (!fileContent.includes(op.old)) {
              const preview = op.old.length > 80 ? op.old.slice(0, 80) + "..." : op.old;
              throw new Error(`replace failed: exact text not found in ${displayPath}: "${preview}"`);
            }

            const newText = op.new ?? "";
            let replacements = 0;
            if (op.replace_all) {
              replacements = fileContent.split(op.old).length - 1;
              fileContent = fileContent.replaceAll(op.old, newText);
            } else {
              replacements = 1;
              const idx = fileContent.indexOf(op.old);
              fileContent = fileContent.slice(0, idx) + newText + fileContent.slice(idx + op.old.length);
            }

            await fs.writeFile(absPath, fileContent, "utf-8");
            results.push({ op: "replace", path: displayPath, replacements, ok: true });
          } else if (op.op === "patch") {
            const patchText = op.patch || op.content || "";
            const patchOps = parseMultiFilePatch(patchText);

            if (patchOps.length === 0 && op.path) {
              const absPath = ctx.workspace.resolve(op.path);
              const displayPath = ctx.workspace.display(absPath);
              const original = await fs.readFile(absPath, "utf-8");
              const hunks = parseHunks(patchText);
              const modified = applyHunksToText(original, hunks);
              await fs.writeFile(absPath, modified, "utf-8");
              results.push({ op: "patch", path: displayPath, ok: true });
            } else if (patchOps.length > 0) {
              for (const pOp of patchOps) {
                const absPath = ctx.workspace.resolve(pOp.path);
                const displayPath = ctx.workspace.display(absPath);

                if (pOp.operation === "delete") {
                  await fs.rm(absPath, { recursive: true, force: true });
                  results.push({ op: "patch", action: "delete", path: displayPath, ok: true });
                } else if (pOp.operation === "create") {
                  await fs.mkdir(path.dirname(absPath), { recursive: true });
                  await fs.writeFile(absPath, pOp.content ?? "", "utf-8");
                  results.push({ op: "patch", action: "create", path: displayPath, ok: true });
                } else if (pOp.operation === "move") {
                  if (!pOp.destPath) throw new Error(`Destination path required for move in patch on ${displayPath}`);
                  const destAbs = ctx.workspace.resolve(pOp.destPath);
                  const destDisplay = ctx.workspace.display(destAbs);
                  await fs.mkdir(path.dirname(destAbs), { recursive: true });
                  if (pOp.hunks && pOp.hunks.length > 0) {
                    const original = await fs.readFile(absPath, "utf-8");
                    const modified = applyHunksToText(original, pOp.hunks);
                    await fs.writeFile(destAbs, modified, "utf-8");
                    await fs.rm(absPath, { force: true });
                  } else {
                    await fs.rename(absPath, destAbs);
                  }
                  results.push({ op: "patch", action: "move", path: `${displayPath} -> ${destDisplay}`, ok: true });
                } else if (pOp.operation === "update") {
                  const original = await fs.readFile(absPath, "utf-8");
                  const modified = applyHunksToText(original, pOp.hunks ?? []);
                  await fs.writeFile(absPath, modified, "utf-8");
                  results.push({ op: "patch", action: "update", path: displayPath, ok: true });
                }
              }
            } else {
              throw new Error("No file operations or hunks found in patch");
            }
          } else if (op.op === "move") {
            if (!op.path || !op.to) throw new Error("path (source) and to (destination) are required for 'move' operation");
            const srcAbs = ctx.workspace.resolve(op.path);
            const destAbs = ctx.workspace.resolve(op.to);
            await fs.mkdir(path.dirname(destAbs), { recursive: true });
            await fs.rename(srcAbs, destAbs);
            results.push({ op: "move", from: ctx.workspace.display(srcAbs), to: ctx.workspace.display(destAbs), ok: true });
          } else if (op.op === "copy") {
            if (!op.path || !op.to) throw new Error("path (source) and to (destination) are required for 'copy' operation");
            const srcAbs = ctx.workspace.resolve(op.path);
            const destAbs = ctx.workspace.resolve(op.to);
            await fs.mkdir(path.dirname(destAbs), { recursive: true });
            await fs.cp(srcAbs, destAbs, { recursive: true });
            results.push({ op: "copy", from: ctx.workspace.display(srcAbs), to: ctx.workspace.display(destAbs), ok: true });
          } else if (op.op === "delete") {
            if (!op.path) throw new Error("path is required for 'delete' operation");
            const targetAbs = ctx.workspace.resolve(op.path);
            await fs.rm(targetAbs, { recursive: true, force: true });
            results.push({ op: "delete", path: ctx.workspace.display(targetAbs), ok: true });
          } else if (op.op === "mkdir") {
            if (!op.path) throw new Error("path is required for 'mkdir' operation");
            const targetAbs = ctx.workspace.resolve(op.path);
            await fs.mkdir(targetAbs, { recursive: true });
            results.push({ op: "mkdir", path: ctx.workspace.display(targetAbs), ok: true });
          } else if (op.op === "undo") {
            if (!op.checkpoint_id) throw new Error("checkpoint_id is required for 'undo' operation");
            const res = await restoreCheckpoint(ctx.config, op.checkpoint_id);
            for (const p of res.restoredFiles) {
              affectedPaths.add(p);
            }
            results.push({
              op: "undo",
              checkpoint_id: res.id,
              restored_files: res.restoredFiles.map((p) => ctx.workspace.display(p)),
              ok: true,
            });
          }
        }
      } catch (err: unknown) {
        // If execution fails, restore the snapshot to leave repository in clean state
        if (checkpointId) {
          await restoreCheckpoint(ctx.config, checkpointId).catch(() => {});
        }
        throw err;
      }

      const diagnostics = await runDiagnostics(Array.from(affectedPaths), ctx.workspace.active());
      const errorCount = diagnostics.filter((d) => d.severity === "error").length;
      const hint = errorCount > 0
        ? `${errorCount} error${errorCount === 1 ? "" : "s"} after edit — fix before continuing`
        : undefined;

      const summaryText = hint
        ? `Applied ${results.length} operation(s) (${hint})`
        : `Applied ${results.length} operation(s)`;

      return ok("edit_files", summaryText, {
        operations: results,
        checkpoint_id: checkpointId,
        diagnostics,
        ...(hint ? { diagnostic_hint: hint } : {}),
      });
    } catch (err) {
      return fail("edit_files", err);
    }
  },
});

const tools: ToolModule = [readTool, listTool, checkpointsTool, editFilesTool];
export default tools;
