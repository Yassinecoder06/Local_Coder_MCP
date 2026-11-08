/**
 * CONTRACT (interface) owned by orchestrator; implementation owned by agy1 (core).
 * Resolves paths for tools. Relative paths resolve against the active root.
 * Absolute paths are allowed anywhere the process can see (inside Docker that is
 * only the mounted project folders).
 */
import fs from "node:fs";
import path from "node:path";

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
        const resolvedRoots = roots.map((r) => path.resolve(r));
        const allowed = resolvedRoots.some(
          (r) => abs === r || abs.startsWith(r.endsWith(path.sep) ? r : r + path.sep)
        );
        if (allowed) {
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
  onActiveChanged?: (newActive: string) => void
): Workspace {
  const resolvedRoots = roots.map((r) => path.resolve(r));
  let current = path.resolve(initial);

  return {
    roots: resolvedRoots,
    active: () => current,
    setActive(dir: string) {
      const abs = path.isAbsolute(dir) ? path.resolve(dir) : path.resolve(current, dir);
      const allowed = resolvedRoots.some(
        (r) => abs === r || abs.startsWith(r.endsWith(path.sep) ? r : r + path.sep)
      );
      if (!allowed) throw new Error(`Not inside a workspace root: ${abs}. Roots: ${resolvedRoots.join(", ")}`);
      current = abs;
      onActiveChanged?.(current);
      return current;
    },
    resolve: (p?: string) => (p ? path.resolve(current, p.replace(/^~(?=$|\/)/, process.env.HOME ?? "~")) : current),
    display: (abs: string) => path.relative(current, abs) || ".",
  };
}
