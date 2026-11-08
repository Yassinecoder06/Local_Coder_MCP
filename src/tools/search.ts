import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isUtf8 } from "node:buffer";
import { z } from "zod";
import { defineTool, type ToolModule } from "../core/types.js";
import { ok, fail } from "../core/result.js";

const execFileAsync = promisify(execFile);

let rgAvailable: boolean | null = null;

async function checkRg(): Promise<boolean> {
  if (rgAvailable !== null) return rgAvailable;
  try {
    await execFileAsync("rg", ["--version"]);
    rgAvailable = true;
  } catch {
    rgAvailable = false;
  }
  return rgAvailable;
}

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

function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, ".*")
    .replace(/(?<!\.)\*/g, "[^/]*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

export const searchTool = defineTool({
  name: "search",
  title: "Search Codebase",
  description: "Search file contents using regex/literal pattern (or search filenames with glob) using ripgrep with JS fallback. Respects .gitignore.",
  group: "search",
  risk: "read",
  input: {
    pattern: z.string().describe("Regex or literal pattern to search for (or file pattern in 'files' mode)"),
    mode: z.enum(["content", "files"]).default("content").optional().describe("Search mode: 'content' (search text in files) or 'files' (find matching filenames)"),
    path: z.string().optional().describe("Directory or file to search within (defaults to active workspace)"),
    glob: z.string().optional().describe("File glob filter for content search, e.g. '*.ts' or '!*.test.ts'"),
    case_sensitive: z.boolean().default(false).optional().describe("Case-sensitive match (default false)"),
    context: z.number().int().min(0).max(10).default(0).optional().describe("Lines of context before and after matches (content mode)"),
    limit: z.number().int().min(1).max(1000).default(100).optional().describe("Maximum matches to return (default 100)"),
  },
  handler: async (args, ctx) => {
    try {
      const mode = args.mode ?? "content";
      const targetDir = ctx.workspace.resolve(args.path);
      const limit = args.limit ?? 100;
      const caseSensitive = args.case_sensitive ?? false;
      const context = args.context ?? 0;
      const hasRg = await checkRg();

      interface SearchMatch {
        file: string;
        line?: number;
        text?: string;
        context_before?: string[];
        context_after?: string[];
      }

      const matches: SearchMatch[] = [];

      if (hasRg) {
        // Use ripgrep
        if (mode === "files") {
          const rgArgs = ["--files", "--color=never"];
          if (args.glob) rgArgs.push("-g", args.glob);
          if (args.pattern && args.pattern !== "*") {
            rgArgs.push("-g", `*${args.pattern}*`);
          }
          rgArgs.push(targetDir);

          try {
            const { stdout } = await execFileAsync("rg", rgArgs, {
              maxBuffer: 10 * 1024 * 1024,
            });
            const lines = stdout.trim().split("\n").filter(Boolean);
            for (const file of lines.slice(0, limit)) {
              matches.push({ file: ctx.workspace.display(file) });
            }
          } catch (err: any) {
            // rg exits with 1 if no matches found
            if (err.code !== 1) throw err;
          }
        } else {
          // content search
          const rgArgs = ["--color=never", "--no-heading", "--line-number"];
          if (!caseSensitive) rgArgs.push("-i");
          if (context > 0) rgArgs.push("-C", String(context));
          if (args.glob) rgArgs.push("-g", args.glob);
          rgArgs.push("-m", String(limit));
          rgArgs.push("--", args.pattern, targetDir);

          try {
            const { stdout } = await execFileAsync("rg", rgArgs, {
              maxBuffer: 10 * 1024 * 1024,
            });
            const lines = stdout.trim().split("\n").filter(Boolean);
            for (const line of lines) {
              if (matches.length >= limit) break;
              // Format: <file>:<line>:<text> or <file>-<line>-<text>
              const match = line.match(/^([^:]+):(\d+):(.*)$/);
              if (match) {
                matches.push({
                  file: ctx.workspace.display(match[1]),
                  line: Number(match[2]),
                  text: match[3],
                });
              } else {
                // Non-matching context line or separator
                const ctxMatch = line.match(/^([^:-]+)-(\d+)-(.*)$/);
                if (ctxMatch) {
                  matches.push({
                    file: ctx.workspace.display(ctxMatch[1]),
                    line: Number(ctxMatch[2]),
                    text: ctxMatch[3],
                  });
                }
              }
            }
          } catch (err: any) {
            if (err.code !== 1) throw err;
          }
        }
      } else {
        // Pure JavaScript Fallback
        const globMatcher = args.glob ? globToRegex(args.glob) : null;
        let regex: RegExp;
        try {
          regex = new RegExp(args.pattern, caseSensitive ? "" : "i");
        } catch {
          regex = new RegExp(args.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), caseSensitive ? "" : "i");
        }

        async function walk(dir: string): Promise<void> {
          if (matches.length >= limit) return;
          let dirents;
          try {
            dirents = await fs.readdir(dir, { withFileTypes: true });
          } catch {
            return;
          }

          for (const dirent of dirents) {
            if (matches.length >= limit) break;
            if (dirent.name.startsWith(".") && dirent.name !== ".") continue;
            if (dirent.isDirectory() && IGNORED_DIRS.has(dirent.name)) continue;

            const fullPath = path.join(dir, dirent.name);

            if (dirent.isDirectory()) {
              await walk(fullPath);
              continue;
            }

            if (!dirent.isFile()) continue;

            const display = ctx.workspace.display(fullPath);

            if (mode === "files") {
              if (globMatcher && !globMatcher.test(dirent.name) && !globMatcher.test(display)) {
                continue;
              }
              if (regex.test(dirent.name) || regex.test(display)) {
                matches.push({ file: display });
              }
            } else {
              // content search
              if (globMatcher && !globMatcher.test(dirent.name) && !globMatcher.test(display)) {
                continue;
              }

              let stat;
              try {
                stat = await fs.stat(fullPath);
                if (stat.size > 2 * 1024 * 1024) continue; // skip files > 2 MB
              } catch {
                continue;
              }

              let buf;
              try {
                buf = await fs.readFile(fullPath);
                if (!isUtf8(buf)) continue; // skip binary
              } catch {
                continue;
              }

              const text = buf.toString("utf-8");
              const lines = text.split(/\r?\n/);

              for (let i = 0; i < lines.length; i++) {
                if (matches.length >= limit) break;
                const lineText = lines[i];
                if (regex.test(lineText)) {
                  const ctxBefore = context > 0 ? lines.slice(Math.max(0, i - context), i) : undefined;
                  const ctxAfter =
                    context > 0 ? lines.slice(i + 1, Math.min(lines.length, i + 1 + context)) : undefined;

                  matches.push({
                    file: display,
                    line: i + 1,
                    text: lineText,
                    context_before: ctxBefore,
                    context_after: ctxAfter,
                  });
                }
              }
            }
          }
        }

        // Check if targetDir is a single file
        const stat = await fs.stat(targetDir).catch(() => null);
        if (stat?.isFile()) {
          const display = ctx.workspace.display(targetDir);
          const buf = await fs.readFile(targetDir);
          if (isUtf8(buf)) {
            const lines = buf.toString("utf-8").split(/\r?\n/);
            for (let i = 0; i < lines.length && matches.length < limit; i++) {
              if (regex.test(lines[i])) {
                matches.push({ file: display, line: i + 1, text: lines[i] });
              }
            }
          }
        } else {
          await walk(targetDir);
        }
      }

      return ok("search", `Found ${matches.length} result(s) for "${args.pattern}" (${mode} mode)`, {
        mode,
        pattern: args.pattern,
        total: matches.length,
        matches,
      });
    } catch (err) {
      return fail("search", err);
    }
  },
});

const tools: ToolModule = [searchTool];
export default tools;
