/**
 * CONTRACT (interface) owned by orchestrator; implementation owned by agy1 (core).
 * Resolves paths for tools. Relative paths resolve against the active root.
 * Absolute paths are allowed anywhere the process can see (inside Docker that is
 * only the mounted project folders).
 */
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

export function createWorkspace(roots: string[], initial: string): Workspace {
  let current = path.resolve(initial);
  return {
    roots,
    active: () => current,
    setActive(dir: string) {
      const abs = path.resolve(current, dir);
      const allowed = roots.some((r) => abs === r || abs.startsWith(r + path.sep));
      if (!allowed) throw new Error(`Not inside a workspace root: ${abs}. Roots: ${roots.join(", ")}`);
      current = abs;
      return current;
    },
    resolve: (p?: string) => (p ? path.resolve(current, p.replace(/^~(?=$|\/)/, process.env.HOME ?? "~")) : current),
    display: (abs: string) => path.relative(current, abs) || ".",
  };
}
