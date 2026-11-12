import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { defineTool, type ToolModule } from "../core/types.js";
import { ok, fail } from "../core/result.js";
import { getAgentMemory, saveAgentMemory, isPlanCurrent, PLAN_NUDGE_HINT, shouldNudgeWorkspace, recordPlanNudge } from "./lib/memory.js";

const execFileAsync = promisify(execFile);

interface WorkspaceInspection {
  git: { is_repo: boolean; branch?: string; clean?: boolean; summary?: string };
  stack: string[];
  scripts?: Record<string, string>;
  instructions?: string;
}

async function inspectWorkspace(active: string): Promise<WorkspaceInspection> {
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

  return { git: gitInfo, stack, scripts, instructions };
}

export const workspaceInfoTool = defineTool({
  name: "workspace_info",
  title: "Workspace Info",
  description: "Inspect active project root, workspace roots, git status summary, detected stack, scripts, and instructions. Call once at session start.",
  group: "workspace",
  risk: "read",
  input: {},
  handler: async (_args, ctx) => {
    try {
      const active = ctx.workspace.active();
      const roots = ctx.workspace.roots;
      const displayPath = ctx.workspace.display(active);
      const inspection = await inspectWorkspace(active);

      return ok("workspace_info", `Workspace: ${active} (${inspection.stack.join(", ") || "generic"})`, {
        active,
        display: displayPath,
        roots,
        git: inspection.git,
        stack: inspection.stack,
        scripts: inspection.scripts,
        instructions: inspection.instructions,
      });
    } catch (err) {
      return fail("workspace_info", err);
    }
  },
});

export const workspaceSwitchTool = defineTool({
  name: "workspace_switch",
  title: "Switch Workspace",
  description: "Switch active project directory within configured roots. Returns absolute path, stack, and git branch summary to eliminate extra calls.",
  group: "workspace",
  risk: "read",
  input: {
    path: z.string().describe("Target workspace path to activate (must be within configured workspace roots)"),
  },
  handler: async (args, ctx) => {
    try {
      const previousActive = ctx.workspace.active();
      const target = args.path.trim();
      const newActive = ctx.workspace.setActive(target);
      const displayPath = ctx.workspace.display(newActive);
      const inspection = await inspectWorkspace(newActive);

      const stackStr = inspection.stack.length > 0 ? ` [stack: ${inspection.stack.join(", ")}]` : "";
      const branchStr = inspection.git.branch ? ` [git: ${inspection.git.branch}]` : "";
      let summary = `Active workspace is now ${newActive}${stackStr}${branchStr}`;

      const prevResolved = path.resolve(previousActive);
      const newResolved = path.resolve(newActive);
      const isDescendant =
        newResolved !== prevResolved &&
        newResolved.startsWith(prevResolved.endsWith(path.sep) ? prevResolved : prevResolved + path.sep);

      const now = Date.now();
      const prevMemory = await getAgentMemory(ctx.config.dataDir, previousActive);
      const prevAgeMs = now - (Date.parse(prevMemory.updatedAt) || 0);
      const prevUpdatedInLast2h = prevAgeMs <= 2 * 3600 * 1000;
      const prevNotAllDone = prevMemory.todos.length > 0 && prevMemory.todos.some((t) => t.status !== "done");

      const newMemory = await getAgentMemory(ctx.config.dataDir, newActive);
      const newHasNoCurrentPlan = !isPlanCurrent(newMemory, now);

      let movedPlan: { steps: number; from: string; to: string } | undefined;

      if (isDescendant && prevUpdatedInLast2h && prevNotAllDone && newHasNoCurrentPlan) {
        const todosToMove = prevMemory.todos;
        await saveAgentMemory(ctx.config.dataDir, newActive, {
          workspace: newActive,
          updatedAt: new Date().toISOString(),
          todos: todosToMove,
        });
        await saveAgentMemory(ctx.config.dataDir, previousActive, {
          workspace: previousActive,
          updatedAt: new Date().toISOString(),
          todos: [],
        });
        ctx.board?.emitPlan(newActive, todosToMove);
        ctx.board?.emitPlan(previousActive, []);

        summary += `. Moved your plan (${todosToMove.length} steps) from ${previousActive} to ${newActive}.`;
        movedPlan = { steps: todosToMove.length, from: previousActive, to: newActive };
      } else if (newHasNoCurrentPlan && shouldNudgeWorkspace(ctx, newActive, now)) {
        recordPlanNudge(ctx, newActive, now);
        summary += `\n${PLAN_NUDGE_HINT}`;
      }

      return ok("workspace_switch", summary, {
        active: newActive,
        display: displayPath,
        git: inspection.git,
        stack: inspection.stack,
        scripts: inspection.scripts,
        ...(movedPlan ? { moved_plan: movedPlan } : {}),
      });
    } catch (err) {
      return fail("workspace_switch", err);
    }
  },
});

const tools: ToolModule = [workspaceInfoTool, workspaceSwitchTool];
export default tools;
