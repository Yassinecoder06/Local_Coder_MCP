/**
 * CONTRACT (interface) owned by orchestrator; implementation owned by agy1 (core).
 * Resolves paths for tools. Relative paths resolve against the active root.
 * Absolute paths are allowed anywhere the process can see (inside Docker that is
 * only the mounted project folders).
 */
import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "../config.js";
import { getSettings, type Settings } from "./settings.js";

export interface Workspace {
  readonly roots: string[];
  /** Currently active project root (per MCP session). */
  active(): string;
  /** Switch active root; must be one of roots or a sub-directory of one. Returns the new root. */
  setActive(dir: string): string;
  /** Resolve a user-supplied path (relative -> active root). Never throws for valid strings. */
  resolve(p?: string): string;
  /** Path relative to the active root for display ("." for the root itself). */
  display(abs: string): string;
  /** Update roots live and fall back to default if current active root is no longer valid. */
  updateRoots?(newRoots: string[], newDefault?: string): void;
}

export interface EffectiveWorkspaces {
  roots: string[];
  defaultWorkspace: string;
  source: "settings" | "env";
}

/**
 * Resolves effective workspace roots and default workspace from settings or config env fallback.
 */
export function resolveWorkspaces(
  config: AppConfig,
  settings: Settings = getSettings()
): EffectiveWorkspaces {
  if (Array.isArray(settings.workspaceRoots) && settings.workspaceRoots.length > 0) {
    const roots = settings.workspaceRoots.map((r) => path.resolve(r));
    let defaultWorkspace = settings.defaultWorkspace ? path.resolve(settings.defaultWorkspace) : roots[0];
    const isInside = isPathInsideRoots(defaultWorkspace, roots);
    if (!isInside) {
      defaultWorkspace = roots[0];
    }
    return {
      roots,
      defaultWorkspace,
      source: "settings",
    };
  }

  const roots = (config.workspaceRoots && config.workspaceRoots.length > 0)
    ? config.workspaceRoots.map((r) => path.resolve(r))
    : [process.cwd()];
  let defaultWorkspace = config.defaultWorkspace ? path.resolve(config.defaultWorkspace) : roots[0];
  const isInside = isPathInsideRoots(defaultWorkspace, roots);
  if (!isInside) {
    defaultWorkspace = roots[0];
  }
  return {
    roots,
    defaultWorkspace,
    source: "env",
  };
}

/**
 * Checks whether targetPath is inside at least one of the given roots (both lexically and via realpath).
 */
export function isPathInsideRoots(targetPath: string, roots: string[]): boolean {
  const absTarget = path.resolve(targetPath);
  let realTarget = absTarget;
  try {
    realTarget = fs.realpathSync(absTarget);
  } catch {
    try {
      realTarget = path.join(fs.realpathSync(path.dirname(absTarget)), path.basename(absTarget));
    } catch {}
  }

  return roots.some((root) => {
    const absRoot = path.resolve(root);
    let realRoot = absRoot;
    try {
      realRoot = fs.realpathSync(absRoot);
    } catch {}

    const lexical = absTarget === absRoot || absTarget.startsWith(absRoot.endsWith(path.sep) ? absRoot : absRoot + path.sep);
    const real = realTarget === realRoot || realTarget.startsWith(realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep);
    return lexical && real;
  });
}

/**
 * Validates a workspace root path: exists, is directory, readable, and realpath inside allowedRootAreas.
 */
export function validateWorkspacePath(candidate: string, allowedAreas: string[]): string {
  const abs = path.resolve(candidate);
  if (!fs.existsSync(abs)) {
    throw new Error(`Workspace path does not exist: ${candidate}`);
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    throw new Error(`Failed to access workspace path: ${candidate}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Workspace path is not a directory: ${candidate}`);
  }
  try {
    fs.accessSync(abs, fs.constants.R_OK);
  } catch {
    throw new Error(`Workspace path is not readable: ${candidate}`);
  }

  const realCandidate = fs.realpathSync(abs);
  const isAllowed = allowedAreas.some((area) => {
    let realArea = path.resolve(area);
    try {
      realArea = fs.realpathSync(realArea);
    } catch {}
    return (
      realCandidate === realArea ||
      realCandidate.startsWith(realArea.endsWith(path.sep) ? realArea : realArea + path.sep)
    );
  });

  if (!isAllowed) {
    throw new Error(
      `Path '${candidate}' is outside allowed mount areas (${allowedAreas.join(", ")}). Set MOUNT_DIR or ALLOWED_ROOTS in .env and restart.`
    );
  }

  return abs;
}

/**
 * Validates defaultWorkspace: exists, is directory, and inside one of the validated roots.
 */
export function validateDefaultWorkspace(defaultWs: string, roots: string[]): string {
  const abs = path.resolve(defaultWs);
  if (!fs.existsSync(abs)) {
    throw new Error(`Default workspace path does not exist: ${defaultWs}`);
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    throw new Error(`Failed to access default workspace path: ${defaultWs}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Default workspace path is not a directory: ${defaultWs}`);
  }
  try {
    fs.accessSync(abs, fs.constants.R_OK);
  } catch {
    throw new Error(`Default workspace path is not readable: ${defaultWs}`);
  }

  if (!isPathInsideRoots(abs, roots)) {
    throw new Error(`Default workspace '${defaultWs}' is not inside any of the configured workspace roots.`);
  }

  return abs;
}

export function resolveInitialWorkspace(
  roots: string[],
  defaultWorkspace: string,
  lastWorkspace?: string
): string {
  if (lastWorkspace && typeof lastWorkspace === "string" && lastWorkspace.trim().length > 0) {
    try {
      const abs = path.resolve(lastWorkspace);
      if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
        if (isPathInsideRoots(abs, roots)) {
          return abs;
        }
      }
    } catch {}
  }
  return path.resolve(defaultWorkspace);
}

export function createWorkspace(
  roots: string[],
  initial: string,
  onActiveChanged?: (newActive: string) => void,
  getEffectiveRoots?: () => string[]
): Workspace {
  let resolvedRoots = roots.map((r) => path.resolve(r));
  let current = path.resolve(initial);

  return {
    get roots() {
      return getEffectiveRoots ? getEffectiveRoots().map((r) => path.resolve(r)) : resolvedRoots;
    },
    active: () => current,
    setActive(dir: string) {
      const effectiveRoots = getEffectiveRoots ? getEffectiveRoots().map((r) => path.resolve(r)) : resolvedRoots;
      const abs = path.isAbsolute(dir) ? path.resolve(dir) : path.resolve(current, dir);
      if (!isPathInsideRoots(abs, effectiveRoots)) {
        throw new Error(`Not inside a workspace root: ${abs}. Roots: ${effectiveRoots.join(", ")}`);
      }
      current = abs;
      onActiveChanged?.(current);
      return current;
    },
    updateRoots(newRoots: string[], newDefault?: string) {
      resolvedRoots = newRoots.map((r) => path.resolve(r));
      const stillValid = isPathInsideRoots(current, resolvedRoots);
      if (!stillValid) {
        current = path.resolve(newDefault ?? resolvedRoots[0]);
        onActiveChanged?.(current);
      }
    },
    resolve: (p?: string) => (p ? path.resolve(current, p.replace(/^~(?=$|\/)/, process.env.HOME ?? "~")) : current),
    display: (abs: string) => path.relative(current, abs) || ".",
  };
}
