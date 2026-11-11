/** SHARED CONTRACT — result envelope helpers. */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ToolResult, TruncationRecord } from "./types.js";

export function ok<T>(tool: string, summary: string, data?: T): ToolResult<T> {
  return { ok: true, tool, summary, data };
}

export function fail(tool: string, error: unknown, data?: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, tool, summary: message, error: message, data };
}

/** MCP output schema advertised for every native tool. */
export const RESULT_OUTPUT_SCHEMA = {
  ok: z.boolean(),
  tool: z.string(),
  summary: z.string(),
  data: z.unknown().optional(),
  error: z.string().optional(),
  truncated: z.boolean().optional(),
  truncation: z
    .array(
      z.object({
        path: z.string(),
        keptBytes: z.number(),
        omittedBytes: z.number(),
      })
    )
    .optional(),
};

export interface TruncateOptions {
  headRatio?: number;
  tailRatio?: number;
}

export interface TruncateResult {
  text: string;
  keptBytes: number;
  omittedBytes: number;
}

/**
 * Finds the safe byte offset (<= targetEnd) in a Buffer that does not split a multi-byte UTF-8 character.
 */
export function findUtf8HeadEnd(buf: Buffer, targetEnd: number): number {
  let end = Math.min(buf.length, Math.max(0, targetEnd));
  let i = end - 1;
  let contCount = 0;
  while (i >= 0 && (buf[i] & 0xc0) === 0x80) {
    contCount++;
    i--;
  }
  if (i >= 0) {
    const lead = buf[i];
    let needCont = 0;
    if (lead >= 0xf0) needCont = 3;
    else if (lead >= 0xe0) needCont = 2;
    else if (lead >= 0xc0) needCont = 1;
    if (contCount < needCont) {
      end = i;
    }
  }
  return end;
}

/**
 * Finds the safe byte offset (>= targetStart) in a Buffer that begins on a UTF-8 character lead byte.
 */
export function findUtf8TailStart(buf: Buffer, targetStart: number): number {
  let start = Math.max(0, Math.min(buf.length, targetStart));
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) {
    start++;
  }
  return start;
}

/**
 * Slices a string to a safe UTF-8 byte length prefix.
 */
export function utf8SafePrefix(str: string, maxBytes: number): string {
  const buf = Buffer.from(str, "utf-8");
  if (buf.length <= maxBytes) return str;
  const headEnd = findUtf8HeadEnd(buf, maxBytes);
  return buf.subarray(0, headEnd).toString("utf-8");
}

/**
 * Truncate a string or Buffer to head + tail with a marker line:
 * `… [N bytes omitted — use job output / read with a range for the rest] …`
 * Snaps to line boundaries when possible.
 */
export function truncateHeadTail(
  value: string | Buffer,
  maxBytes: number,
  options: TruncateOptions = {}
): TruncateResult {
  const buf = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf-8");
  const totalBytes = buf.length;
  if (maxBytes <= 0) {
    return { text: "", keptBytes: 0, omittedBytes: totalBytes };
  }
  if (totalBytes <= maxBytes) {
    return {
      text: typeof value === "string" ? value : buf.toString("utf-8"),
      keptBytes: totalBytes,
      omittedBytes: 0,
    };
  }

  const headRatio = options.headRatio ?? 0.6;
  const tailRatio = options.tailRatio ?? 0.4;
  const norm = headRatio + tailRatio;
  const hR = norm > 0 ? headRatio / norm : 0.6;

  const dummyMarker = `\n… [${totalBytes} bytes omitted — use job output / read with a range for the rest] …\n`;
  const markerOverhead = Buffer.byteLength(dummyMarker, "utf-8");

  if (maxBytes <= markerOverhead) {
    const fallbackText = utf8SafePrefix(dummyMarker.trim(), maxBytes);
    return {
      text: fallbackText,
      keptBytes: 0,
      omittedBytes: totalBytes,
    };
  }

  const budgetForContent = maxBytes - markerOverhead;
  const targetHeadBytes = Math.max(0, Math.floor(budgetForContent * hR));
  const targetTailBytes = Math.max(0, budgetForContent - targetHeadBytes);

  let headEnd = findUtf8HeadEnd(buf, targetHeadBytes);
  if (headEnd > 0) {
    const lastNl = buf.lastIndexOf(0x0a, headEnd - 1);
    if (lastNl !== -1 && lastNl >= Math.floor(headEnd * 0.7)) {
      headEnd = lastNl + 1;
    }
  }

  let targetTailStart = totalBytes - targetTailBytes;
  let tailStart = findUtf8TailStart(buf, targetTailStart);
  if (tailStart < totalBytes) {
    const firstNl = buf.indexOf(0x0a, tailStart);
    if (firstNl !== -1 && firstNl <= tailStart + Math.floor(targetTailBytes * 0.3)) {
      tailStart = firstNl + 1;
    }
  }

  if (tailStart < headEnd) {
    tailStart = headEnd;
  }

  const headBytes = headEnd;
  const tailBytes = totalBytes - tailStart;
  const omittedBytes = totalBytes - (headBytes + tailBytes);
  const keptBytes = headBytes + tailBytes;

  const marker = `… [${omittedBytes} bytes omitted — use job output / read with a range for the rest] …`;
  const headStr = buf.subarray(0, headEnd).toString("utf-8");
  const tailStr = buf.subarray(tailStart).toString("utf-8");

  let result = "";
  if (headEnd > 0) {
    result += headStr;
    if (!headStr.endsWith("\n")) result += "\n";
  }
  result += marker;
  if (tailStart < totalBytes) {
    if (!tailStr.startsWith("\n")) result += "\n";
    result += tailStr;
  }

  return {
    text: result,
    keptBytes,
    omittedBytes,
  };
}

interface StringRef {
  path: string;
  parent: any;
  key: string | number | null;
  value: string;
  byteLength: number;
}

function collectStringRefs(data: unknown): StringRef[] {
  const refs: StringRef[] = [];
  if (typeof data === "string") {
    refs.push({
      path: "data",
      parent: null,
      key: null,
      value: data,
      byteLength: Buffer.byteLength(data, "utf-8"),
    });
    return refs;
  }

  function walk(current: unknown, currentPath: string) {
    if (!current || typeof current !== "object") return;
    if (Array.isArray(current)) {
      for (let i = 0; i < current.length; i++) {
        const item = current[i];
        const itemPath = `${currentPath}[${i}]`;
        if (typeof item === "string") {
          refs.push({
            path: itemPath,
            parent: current,
            key: i,
            value: item,
            byteLength: Buffer.byteLength(item, "utf-8"),
          });
        } else if (item && typeof item === "object") {
          walk(item, itemPath);
        }
      }
    } else {
      for (const [key, value] of Object.entries(current)) {
        const propPath = `${currentPath}.${key}`;
        if (typeof value === "string") {
          refs.push({
            path: propPath,
            parent: current,
            key,
            value,
            byteLength: Buffer.byteLength(value, "utf-8"),
          });
        } else if (value && typeof value === "object") {
          walk(value, propPath);
        }
      }
    }
  }

  walk(data, "data");
  return refs;
}

function allocateReductions(lengths: number[], totalReductionNeeded: number): number[] {
  const items = lengths.map((len, idx) => ({ len, idx, current: len })).sort((a, b) => b.len - a.len);
  let remaining = totalReductionNeeded;

  while (remaining > 0) {
    const maxVal = items[0].current;
    if (maxVal <= 100) break;
    let count = 0;
    while (count < items.length && items[count].current === maxVal) count++;
    const nextVal = count < items.length ? items[count].current : 100;
    const step = maxVal - nextVal;
    if (step === 0) break;
    const totalStep = step * count;
    if (totalStep <= remaining) {
      for (let i = 0; i < count; i++) items[i].current = nextVal;
      remaining -= totalStep;
    } else {
      const perItem = Math.floor(remaining / count);
      const rem = remaining % count;
      for (let i = 0; i < count; i++) {
        items[i].current = maxVal - perItem - (i < rem ? 1 : 0);
      }
      remaining = 0;
    }
  }
  const result = new Array(lengths.length);
  for (const item of items) result[item.idx] = item.current;
  return result;
}

function deepCloneContainers(obj: unknown): any {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(deepCloneContainers);
  const copy: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    copy[k] = deepCloneContainers(v);
  }
  return copy;
}

function pruneLongArrays(obj: unknown): boolean {
  if (!obj || typeof obj !== "object") return false;
  let pruned = false;
  if (Array.isArray(obj)) {
    if (obj.length > 2) {
      const first = obj[0];
      const last = obj[obj.length - 1];
      const omitted = obj.length - 2;
      obj.length = 0;
      obj.push(first, { omitted }, last);
      pruned = true;
    }
    for (const item of obj) {
      if (item && typeof item === "object") {
        if (pruneLongArrays(item)) pruned = true;
      }
    }
  } else {
    for (const val of Object.values(obj)) {
      if (val && typeof val === "object") {
        if (pruneLongArrays(val)) pruned = true;
      }
    }
  }
  return pruned;
}

function shrinkToolResult(
  result: ToolResult,
  maxBytes: number
): { shrunkResult: ToolResult; shrunkText: string } {
  if (result.data === undefined) {
    const fallback = { ...result, data: "[truncated — narrow the request]", truncated: true };
    let fbText = JSON.stringify(fallback);
    if (Buffer.byteLength(fbText, "utf-8") > maxBytes) {
      fbText = utf8SafePrefix(fbText, maxBytes);
    }
    return { shrunkResult: fallback, shrunkText: fbText };
  }

  let data = deepCloneContainers(result.data);
  let stringRefs = collectStringRefs(data);
  const truncation: TruncationRecord[] = [];

  if (stringRefs.length > 0) {
    const currentBytes = Buffer.byteLength(JSON.stringify({ ...result, data }), "utf-8");
    const excess = currentBytes - maxBytes;
    if (excess > 0) {
      const margin = 250 + stringRefs.length * 120;
      const neededReduction = excess + margin;
      const lengths = stringRefs.map((r) => r.byteLength);
      const targets = allocateReductions(lengths, neededReduction);

      for (let i = 0; i < stringRefs.length; i++) {
        if (targets[i] < stringRefs[i].byteLength) {
          const ref = stringRefs[i];
          const tr = truncateHeadTail(ref.value, targets[i], { headRatio: 0.6, tailRatio: 0.4 });
          if (ref.parent !== null && ref.key !== null) {
            ref.parent[ref.key] = tr.text;
          } else {
            data = tr.text;
          }
          truncation.push({ path: ref.path, keptBytes: tr.keptBytes, omittedBytes: tr.omittedBytes });
        }
      }
    }
  }

  let candResult: ToolResult = {
    ...result,
    data,
    truncated: true,
    ...(truncation.length > 0 ? { truncation } : {}),
  };
  let candText = JSON.stringify(candResult);
  let candBytes = Buffer.byteLength(candText, "utf-8");

  // If still too big, try pruning long arrays
  if (candBytes > maxBytes) {
    const arraysPruned = pruneLongArrays(data);
    if (arraysPruned) {
      stringRefs = collectStringRefs(data);
      candResult = {
        ...result,
        data,
        truncated: true,
        ...(truncation.length > 0 ? { truncation } : {}),
      };
      candText = JSON.stringify(candResult);
      candBytes = Buffer.byteLength(candText, "utf-8");

      if (candBytes > maxBytes && stringRefs.length > 0) {
        const excess = candBytes - maxBytes;
        const targets = allocateReductions(stringRefs.map((r) => r.byteLength), excess + 250);
        for (let i = 0; i < stringRefs.length; i++) {
          if (targets[i] < stringRefs[i].byteLength) {
            const ref = stringRefs[i];
            const tr = truncateHeadTail(ref.value, targets[i], { headRatio: 0.6, tailRatio: 0.4 });
            if (ref.parent !== null && ref.key !== null) {
              ref.parent[ref.key] = tr.text;
            } else {
              data = tr.text;
            }
            const existing = truncation.find((t) => t.path === ref.path);
            if (existing) {
              existing.keptBytes = tr.keptBytes;
              existing.omittedBytes = tr.omittedBytes;
            } else {
              truncation.push({ path: ref.path, keptBytes: tr.keptBytes, omittedBytes: tr.omittedBytes });
            }
          }
        }
        candResult = {
          ...result,
          data,
          truncated: true,
          ...(truncation.length > 0 ? { truncation } : {}),
        };
        candText = JSON.stringify(candResult);
        candBytes = Buffer.byteLength(candText, "utf-8");
      }
    }
  }

  // If still slightly over maxBytes (e.g. by a few bytes due to JSON escaping or truncation records)
  if (candBytes > maxBytes && stringRefs.length > 0) {
    const excess = candBytes - maxBytes;
    stringRefs = collectStringRefs(data);
    const longest = stringRefs.sort((a, b) => b.byteLength - a.byteLength)[0];
    if (longest && longest.byteLength > excess + 200) {
      const tr = truncateHeadTail(longest.value, longest.byteLength - excess - 150, { headRatio: 0.6, tailRatio: 0.4 });
      if (longest.parent !== null && longest.key !== null) {
        longest.parent[longest.key] = tr.text;
      } else {
        data = tr.text;
      }
      const existing = truncation.find((t) => t.path === longest.path);
      if (existing) {
        existing.keptBytes = tr.keptBytes;
        existing.omittedBytes = tr.omittedBytes;
      } else {
        truncation.push({ path: longest.path, keptBytes: tr.keptBytes, omittedBytes: tr.omittedBytes });
      }
      candResult = {
        ...result,
        data,
        truncated: true,
        ...(truncation.length > 0 ? { truncation } : {}),
      };
      candText = JSON.stringify(candResult);
      candBytes = Buffer.byteLength(candText, "utf-8");
    }
  }

  // If still too big after that, fall back to current behaviour
  if (candBytes > maxBytes) {
    let fallback = { ...result, data: "[truncated — narrow the request]", truncated: true };
    let fbText = JSON.stringify(fallback);
    if (Buffer.byteLength(fbText, "utf-8") > maxBytes) {
      // If summary or error is huge, shrink summary/error so JSON remains valid
      const shrunkSummary = truncateHeadTail(result.summary || "", Math.floor(maxBytes / 3)).text;
      const shrunkError = result.error ? truncateHeadTail(result.error, Math.floor(maxBytes / 3)).text : undefined;
      fallback = {
        ...result,
        summary: shrunkSummary,
        ...(shrunkError !== undefined ? { error: shrunkError } : {}),
        data: "[truncated — narrow the request]",
        truncated: true,
      };
      fbText = JSON.stringify(fallback);
      if (Buffer.byteLength(fbText, "utf-8") > maxBytes) {
        fbText = utf8SafePrefix(fbText, maxBytes);
      }
    }
    return { shrunkResult: fallback, shrunkText: fbText };
  }

  return { shrunkResult: candResult, shrunkText: candText };
}

/**
 * Convert to the MCP wire format. Text content carries the full JSON so clients
 * that ignore structuredContent (Gemini) still see the data.
 */
export function toCallToolResult(withImages: ToolResult, maxBytes: number): CallToolResult {
  const { images, ...result } = withImages;
  const initialText = JSON.stringify(result);
  if (Buffer.byteLength(initialText, "utf-8") <= maxBytes) {
    return {
      content: [{ type: "text", text: initialText }, ...(images ?? []).map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }))],
      structuredContent: result as unknown as Record<string, unknown>,
      isError: !result.ok,
    };
  }

  const { shrunkResult, shrunkText } = shrinkToolResult(result, maxBytes);
  return {
    content: [{ type: "text", text: shrunkText }, ...(images ?? []).map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }))],
    structuredContent: shrunkResult as unknown as Record<string, unknown>,
    isError: !shrunkResult.ok,
  };
}
