/**
 * Owned by agy2. Evidence collection for the finish tool.
 * Gathers recent verification checks, browser checks, git stats, and open user requests.
 */
import { execFile } from "node:child_process";
import path from "node:path";
import type { ActivityEntry } from "../../core/activity.js";
import type { FinishEvidence } from "../../core/board.js";
import type { ToolContext } from "../../core/types.js";

function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, timeout: 5000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      (err, stdout) => {
        resolve(err ? "" : stdout.toString().trim());
      }
    );
  });
}

export function isVerifyRun(entry: ActivityEntry): boolean {
  if (entry.tool !== "run" || !entry.args) return false;
  try {
    const parsed = JSON.parse(entry.args);
    return parsed.verify === true;
  } catch {
    return /"verify"\s*:\s*true/.test(entry.args);
  }
}

export function isBrowserCheck(entry: ActivityEntry): boolean {
  return entry.tool === "browser_check";
}

export function isEditFiles(entry: ActivityEntry): boolean {
  return entry.tool === "edit_files";
}

function matchesWorkspace(entry: ActivityEntry, workspaceRoot: string): boolean {
  if (!entry.args) return true;
  try {
    const parsed = JSON.parse(entry.args);
    if (parsed.cwd && typeof parsed.cwd === "string") {
      const absCwd = path.resolve(parsed.cwd);
      if (absCwd !== workspaceRoot && !absCwd.startsWith(workspaceRoot.endsWith(path.sep) ? workspaceRoot : workspaceRoot + path.sep)) {
        return false;
      }
    }
    if (parsed.path && typeof parsed.path === "string" && path.isAbsolute(parsed.path)) {
      const absPath = path.resolve(parsed.path);
      if (absPath !== workspaceRoot && !absPath.startsWith(workspaceRoot.endsWith(path.sep) ? workspaceRoot : workspaceRoot + path.sep)) {
        return false;
      }
    }
  } catch {
    // Keep entry if args is not JSON
  }
  return true;
}

export async function collectFinishEvidence(
  ctx: ToolContext,
  workspaceRoot: string
): Promise<{ evidence: FinishEvidence; verified: boolean; warnings: string[] }> {
  const entries = ctx.activity.recent(500).filter((e) => matchesWorkspace(e, workspaceRoot));

  let lastVerifyEntry: ActivityEntry | undefined;
  let lastBrowserCheckEntry: ActivityEntry | undefined;
  let lastEditEntry: ActivityEntry | undefined;

  for (const entry of entries) {
    if (!lastVerifyEntry && isVerifyRun(entry)) {
      lastVerifyEntry = entry;
    }
    if (!lastBrowserCheckEntry && isBrowserCheck(entry)) {
      lastBrowserCheckEntry = entry;
    }
    if (!lastEditEntry && isEditFiles(entry)) {
      lastEditEntry = entry;
    }
    if (lastVerifyEntry && lastBrowserCheckEntry && lastEditEntry) {
      break;
    }
  }

  const verify = lastVerifyEntry
    ? { ok: lastVerifyEntry.ok, at: lastVerifyEntry.ts, summary: lastVerifyEntry.summary }
    : undefined;

  const browserCheck = lastBrowserCheckEntry
    ? { ok: lastBrowserCheckEntry.ok, at: lastBrowserCheckEntry.ts, summary: lastBrowserCheckEntry.summary }
    : undefined;

  // Git diff stats and branch
  let git: FinishEvidence["git"] | undefined;
  try {
    const isRepo = await runGit(["rev-parse", "--is-inside-work-tree"], workspaceRoot);
    if (isRepo === "true") {
      const branch = await runGit(["branch", "--show-current"], workspaceRoot);
      const shortstat = await runGit(["diff", "--shortstat"], workspaceRoot);
      const filesMatch = shortstat.match(/(\d+)\s+files?\s+changed/);
      const insMatch = shortstat.match(/(\d+)\s+insertions?\(\+\)/);
      const delMatch = shortstat.match(/(\d+)\s+deletions?\(-\)/);
      git = {
        files: filesMatch ? parseInt(filesMatch[1], 10) : 0,
        insertions: insMatch ? parseInt(insMatch[1], 10) : 0,
        deletions: delMatch ? parseInt(delMatch[1], 10) : 0,
        branch: branch || undefined,
      };
    }
  } catch {
    git = undefined;
  }

  // Open user requests
  let openRequests = 0;
  if (ctx.board) {
    const open = await ctx.board.listRequests({ workspace: workspaceRoot, status: "open" });
    openRequests = open.length;
  }

  const warnings: string[] = [];

  if (openRequests > 0) {
    warnings.push(`${openRequests} open user request(s) pending`);
  }

  const passingVerify = verify?.ok ? lastVerifyEntry : undefined;
  const passingBrowser = browserCheck?.ok ? lastBrowserCheckEntry : undefined;

  if (!passingVerify && !passingBrowser) {
    if (verify && !verify.ok) {
      warnings.push(`Last verify failed: ${verify.summary}`);
    } else if (browserCheck && !browserCheck.ok) {
      warnings.push(`Last browser_check failed: ${browserCheck.summary}`);
    } else {
      warnings.push("No passing verify (run verify:true) or browser_check in recent activity");
    }
  } else if (lastEditEntry) {
    let newestPassing: ActivityEntry;
    if (passingVerify && passingBrowser) {
      newestPassing = (passingVerify.id ?? 0) >= (passingBrowser.id ?? 0) ? passingVerify : passingBrowser;
    } else {
      newestPassing = (passingVerify ?? passingBrowser)!;
    }

    const isNewer =
      typeof newestPassing.id === "number" && typeof lastEditEntry.id === "number"
        ? newestPassing.id > lastEditEntry.id
        : new Date(newestPassing.ts).getTime() > new Date(lastEditEntry.ts).getTime();

    if (!isNewer) {
      warnings.push("No passing verify since the last edit");
    }
  }

  const verified = warnings.length === 0;

  return {
    evidence: {
      verify,
      browserCheck,
      git,
      openRequests,
    },
    verified,
    warnings,
  };
}
