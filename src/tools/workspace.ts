import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { defineTool, type ToolModule } from "../core/types.js";
import { ok, fail } from "../core/result.js";

const execFileAsync = promisify(execFile);

export const workspaceInfoTool = defineTool({
  name: "workspace_info",
  title: "Workspace Info",
  description: "Get active project root, workspace roots, git status summary, detected project stack, package scripts, and instructions from AGENTS.md or CLAUDE.md.",
  group: "workspace",
  risk: "read",
  input: {},
  handler: async (_args, ctx) => {
    try {
      const active = ctx.workspace.active();
      const roots = ctx.workspace.roots;

      // Git inspection
      let gitInfo: { is_repo: boolean; branch?: string; clean?: boolean; summary?: string } = {
        is_repo: false,
      };

      try {
        const { stdout: branchOut } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
          cwd: active,
        });
        const branch = branchOut.trim();

        const { stdout: statusOut } = await execFileAsync("git", ["status", "--porcelain"], {
          cwd: active,
        });
        const lines = statusOut.trim().split("\n").filter(Boolean);
        const clean = lines.length === 0;
        const summary = clean ? "clean" : `${lines.length} uncommitted file(s)`;

        gitInfo = {
          is_repo: true,
          branch,
          clean,
          summary,
        };
      } catch {
        // Not a git repository or git not available
      }

      // Stack & scripts detection
      const stack: string[] = [];
      let scripts: Record<string, string> | undefined;

      try {
        const pkgRaw = await fs.readFile(path.join(active, "package.json"), "utf-8");
        const pkg = JSON.parse(pkgRaw) as {
          scripts?: Record<string, string>;
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
        };
        stack.push("node");
        scripts = pkg.scripts;

        const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (allDeps.typescript) stack.push("typescript");
        if (allDeps.react) stack.push("react");
        if (allDeps.next) stack.push("next.js");
        if (allDeps.express) stack.push("express");
        if (allDeps.vue) stack.push("vue");
      } catch {
        // No package.json
      }

      const checkFile = async (name: string, label: string) => {
        try {
          await fs.access(path.join(active, name));
          stack.push(label);
        } catch {
          // not found
        }
      };

      await checkFile("Cargo.toml", "rust");
      await checkFile("go.mod", "go");
      await checkFile("pyproject.toml", "python");
      await checkFile("requirements.txt", "python");
      await checkFile("Dockerfile", "docker");
      await checkFile("compose.yaml", "docker-compose");

      // Instructions detection (first 8 KB)
      let instructions: string | undefined;
      for (const instFile of ["AGENTS.md", "CLAUDE.md", ".cursorrules"]) {
        try {
          const content = await fs.readFile(path.join(active, instFile), "utf-8");
          instructions = content.slice(0, 8192);
          break;
        } catch {
          // file not found
        }
      }

      const displayPath = ctx.workspace.display(active);
      return ok("workspace_info", `Workspace: ${displayPath} (${stack.join(", ") || "generic"})`, {
        active,
        display: displayPath,
        roots,
        git: gitInfo,
        stack,
        scripts,
        instructions,
      });
    } catch (err) {
      return fail("workspace_info", err);
    }
  },
});

export const workspaceSwitchTool = defineTool({
  name: "workspace_switch",
  title: "Switch Workspace",
  description: "Switch active project root. Path must be within configured workspace roots.",
  group: "workspace",
  risk: "read",
  input: {
    path: z.string().describe("Path to switch to (must be inside configured roots)"),
  },
  handler: async (args, ctx) => {
    try {
      const target = args.path.trim();
      const newActive = ctx.workspace.setActive(target);
      const displayPath = ctx.workspace.display(newActive);
      return ok("workspace_switch", `Active workspace is now ${displayPath}`, {
        active: newActive,
        display: displayPath,
      });
    } catch (err) {
      return fail("workspace_switch", err);
    }
  },
});

const tools: ToolModule = [workspaceInfoTool, workspaceSwitchTool];
export default tools;
