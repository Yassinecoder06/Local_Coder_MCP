import path from "node:path";

function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function detectEol(text: string): "\r\n" | "\n" {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

export interface ParsedHunk {
  oldStart?: number;
  oldLines?: number;
  newStart?: number;
  newLines?: number;
  lines: Array<{ type: "context" | "remove" | "add"; text: string }>;
}

export interface PatchFileOp {
  path: string;
  destPath?: string; // for move
  operation: "create" | "update" | "delete" | "move";
  content?: string;
  hunks?: ParsedHunk[];
  patchText?: string;
}

export function parseHunks(hunkText: string): ParsedHunk[] {
  const normalized = normalizeEol(hunkText.trim());
  const rawLines = normalized.split("\n");
  const hunks: ParsedHunk[] = [];
  let i = 0;

  while (i < rawLines.length) {
    const line = rawLines[i];
    if (line.startsWith("---") || line.startsWith("+++") || line.startsWith("diff ")) {
      i++;
      continue;
    }
    if (!line.startsWith("@@")) {
      i++;
      continue;
    }

    const headerMatch = line.match(/^@@\s*-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
    const hunk: ParsedHunk = {
      oldStart: headerMatch ? Number(headerMatch[1]) : undefined,
      oldLines: headerMatch && headerMatch[2] ? Number(headerMatch[2]) : undefined,
      newStart: headerMatch ? Number(headerMatch[3]) : undefined,
      newLines: headerMatch && headerMatch[4] ? Number(headerMatch[4]) : undefined,
      lines: [],
    };
    i++;

    for (; i < rawLines.length; i++) {
      const patchLine = rawLines[i];
      if (patchLine.startsWith("@@")) {
        break;
      }
      if (patchLine === "\\ No newline at end of file") continue;
      if (patchLine.startsWith(" ")) {
        hunk.lines.push({ type: "context", text: patchLine.slice(1) });
      } else if (patchLine.startsWith("-")) {
        hunk.lines.push({ type: "remove", text: patchLine.slice(1) });
      } else if (patchLine.startsWith("+")) {
        hunk.lines.push({ type: "add", text: patchLine.slice(1) });
      } else if (patchLine.length === 0) {
        hunk.lines.push({ type: "context", text: "" });
      }
    }

    if (hunk.lines.length > 0) hunks.push(hunk);
  }

  return hunks;
}

function hunkSearchPattern(hunk: ParsedHunk): string[] {
  const pattern: string[] = [];
  for (const entry of hunk.lines) {
    if (entry.type === "context" || entry.type === "remove") {
      pattern.push(entry.text);
    }
  }
  return pattern;
}

function hunkReplacement(hunk: ParsedHunk): string[] {
  const replacement: string[] = [];
  for (const entry of hunk.lines) {
    if (entry.type === "context" || entry.type === "add") {
      replacement.push(entry.text);
    }
  }
  return replacement;
}

function matchesAt(haystack: string[], needle: string[], startIndex: number, fuzzy: boolean): boolean {
  if (startIndex + needle.length > haystack.length) return false;
  for (let j = 0; j < needle.length; j++) {
    const h = haystack[startIndex + j];
    const n = needle[j];
    if (fuzzy) {
      if (h.trimEnd() !== n.trimEnd()) return false;
    } else {
      if (h !== n) return false;
    }
  }
  return true;
}

function findPatternIndex(haystack: string[], needle: string[], preferredStart = 0): number {
  if (needle.length === 0) return Math.min(preferredStart, haystack.length);

  // 1. Try exact match at preferredStart
  if (matchesAt(haystack, needle, preferredStart, false)) {
    return preferredStart;
  }

  // 2. Try exact search in haystack outwards or forwards from preferredStart
  for (let i = 0; i <= haystack.length - needle.length; i++) {
    if (matchesAt(haystack, needle, i, false)) {
      return i;
    }
  }

  // 3. Try fuzzy match (ignoring trailing whitespace) at preferredStart
  if (matchesAt(haystack, needle, preferredStart, true)) {
    return preferredStart;
  }

  // 4. Try fuzzy search anywhere
  for (let i = 0; i <= haystack.length - needle.length; i++) {
    if (matchesAt(haystack, needle, i, true)) {
      return i;
    }
  }

  return -1;
}

export function applyHunksToText(original: string, hunks: ParsedHunk[]): string {
  const eol = detectEol(original);
  const normalizedOriginal = normalizeEol(original);
  const output = normalizedOriginal.length > 0 ? normalizedOriginal.split("\n") : [];

  let delta = 0;

  for (let hIdx = 0; hIdx < hunks.length; hIdx++) {
    const hunk = hunks[hIdx];
    const pattern = hunkSearchPattern(hunk);
    const replacement = hunkReplacement(hunk);

    const preferredIndex = hunk.oldStart !== undefined ? Math.max(0, hunk.oldStart - 1 + delta) : 0;
    const matchIndex = findPatternIndex(output, pattern, preferredIndex);

    if (matchIndex < 0) {
      const preview = pattern.slice(0, 4).map((l) => `"${l}"`).join(", ") || "(empty pattern)";
      throw new Error(`Patch hunk #${hIdx + 1} failed: context not found in file. Expected pattern: ${preview}`);
    }

    const removeCount = pattern.length;
    output.splice(matchIndex, removeCount, ...replacement);
    delta += replacement.length - removeCount;
  }

  const result = output.join("\n");
  return eol === "\r\n" ? result.replace(/\n/g, "\r\n") : result;
}

function cleanPath(p: string): string {
  return p.trim().replace(/^['"]|['"]$/g, "").replace(/^[ab]\//, "");
}

export function parseMultiFilePatch(patchText: string): PatchFileOp[] {
  const normalized = normalizeEol(patchText.trim());
  const ops: PatchFileOp[] = [];

  // Check for *** Begin Patch or *** Update File: style
  if (
    normalized.includes("*** Begin Patch") ||
    normalized.includes("*** Update File:") ||
    normalized.includes("*** Add File:") ||
    normalized.includes("*** Delete File:") ||
    normalized.includes("*** Move File:") ||
    normalized.includes("*** Rename File:")
  ) {
    const lines = normalized.split("\n");
    let current: PatchFileOp | null = null;
    const chunk: string[] = [];

    const flush = () => {
      if (!current) return;
      if (current.operation === "create") {
        current.content = chunk
          .filter((l) => l.startsWith("+"))
          .map((l) => l.slice(1))
          .join("\n");
        if (current.content.length === 0 && chunk.length > 0) {
          // If no '+' prefix, use chunk directly
          current.content = chunk.join("\n");
        }
      } else if (current.operation === "update" || current.operation === "move") {
        current.patchText = chunk.join("\n");
        current.hunks = parseHunks(current.patchText);
      }
      ops.push(current);
      current = null;
      chunk.length = 0;
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.startsWith("*** Update File:")) {
        flush();
        current = { path: cleanPath(line.slice(16)), operation: "update" };
        continue;
      }

      if (line.startsWith("*** Add File:")) {
        flush();
        current = { path: cleanPath(line.slice(13)), operation: "create" };
        continue;
      }

      if (line.startsWith("*** Delete File:")) {
        flush();
        ops.push({ path: cleanPath(line.slice(16)), operation: "delete" });
        continue;
      }

      if (line.startsWith("*** Move File:") || line.startsWith("*** Rename File:")) {
        flush();
        const raw = line.slice(line.indexOf(":") + 1).trim();
        if (raw.includes("->")) {
          const [src, dest] = raw.split("->").map(cleanPath);
          current = { path: src, destPath: dest, operation: "move" };
        } else {
          // Check if next line is *** To File:
          const src = cleanPath(raw);
          if (i + 1 < lines.length && lines[i + 1].startsWith("*** To File:")) {
            i++;
            const dest = cleanPath(lines[i].slice(12));
            current = { path: src, destPath: dest, operation: "move" };
          } else {
            current = { path: src, operation: "move" };
          }
        }
        continue;
      }

      if (line.startsWith("*** End Patch") || line.startsWith("*** Begin Patch")) {
        continue;
      }

      if (current) {
        chunk.push(line);
      }
    }
    flush();
    return ops;
  }

  // Plain unified diff format:
  // --- a/path/to/file
  // +++ b/path/to/file
  const fileBlocks = normalized.split(/\n(?=---\s)/);
  for (const block of fileBlocks) {
    const trimmed = block.trim();
    if (!trimmed.startsWith("---")) continue;
    const lines = trimmed.split("\n");
    const oldHeader = lines[0].replace(/^---\s+/, "").trim();
    const newHeader = lines[1] && lines[1].startsWith("+++") ? lines[1].replace(/^\+\+\+\s+/, "").trim() : "";

    const isDelete = newHeader === "/dev/null";
    const isCreate = oldHeader === "/dev/null";
    const targetPath = cleanPath(isDelete ? oldHeader : newHeader || oldHeader);
    const hunkText = lines.slice(newHeader ? 2 : 1).join("\n");

    if (isDelete) {
      ops.push({ path: targetPath, operation: "delete" });
    } else if (isCreate) {
      const content = hunkText
        .split("\n")
        .filter((l) => l.startsWith("+"))
        .map((l) => l.slice(1))
        .join("\n");
      ops.push({ path: targetPath, operation: "create", content });
    } else {
      const hunks = parseHunks(hunkText);
      ops.push({ path: targetPath, operation: "update", hunks, patchText: hunkText });
    }
  }

  return ops;
}
