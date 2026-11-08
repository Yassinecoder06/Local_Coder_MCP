import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export interface Diagnostic {
  file: string;
  line: number;
  col: number;
  severity: "error" | "warning";
  message: string;
}

const VOID_HTML_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
  "!doctype",
]);

function runExec(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    try {
      execFile(
        cmd,
        args,
        {
          cwd,
          timeout: timeoutMs,
          maxBuffer: 2 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          const exitCode = error && typeof error.code === "number" ? error.code : error ? 1 : 0;
          resolve({
            stdout: stdout ? stdout.toString() : "",
            stderr: stderr ? stderr.toString() : "",
            exitCode,
          });
        }
      );
    } catch {
      resolve({ stdout: "", stderr: "", exitCode: 1 });
    }
  });
}

/** Check JavaScript files via node --check */
async function checkJavaScript(filePath: string, displayPath: string): Promise<Diagnostic[]> {
  try {
    const res = await runExec("node", ["--check", filePath], path.dirname(filePath), 5000);
    if (res.exitCode === 0) return [];

    const stderr = res.stderr || res.stdout;
    const match = stderr.match(/^([^\n:]+):(\d+)(?::(\d+))?\n([^\n]*)\n([^\n]*\^)/m);
    let line = 1;
    let col = 1;

    if (match) {
      line = parseInt(match[2], 10) || 1;
      const caretIdx = match[5].indexOf("^");
      col = caretIdx >= 0 ? caretIdx + 1 : 1;
    } else {
      const fallbackMatch = stderr.match(/:(\d+)(?::(\d+))?/);
      if (fallbackMatch) {
        line = parseInt(fallbackMatch[1], 10) || 1;
        col = fallbackMatch[2] ? parseInt(fallbackMatch[2], 10) : 1;
      }
    }

    const msgMatch = stderr.match(/^(?:[A-Za-z]+Error|Error):\s*(.*)$/m);
    const message = msgMatch ? msgMatch[0].trim() : "JavaScript syntax error";

    return [{ file: displayPath, line, col, severity: "error", message }];
  } catch {
    return [];
  }
}

/** Check JSON files via JSON.parse */
async function checkJson(filePath: string, displayPath: string): Promise<Diagnostic[]> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    try {
      JSON.parse(content);
      return [];
    } catch (err: any) {
      const msg = err?.message || "Invalid JSON";
      let line = 1;
      let col = 1;

      const lineColMatch = msg.match(/line (\d+) column (\d+)/i);
      if (lineColMatch) {
        line = parseInt(lineColMatch[1], 10);
        col = parseInt(lineColMatch[2], 10);
      } else {
        const posMatch = msg.match(/at position (\d+)/i);
        if (posMatch) {
          const pos = parseInt(posMatch[1], 10);
          const prefix = content.slice(0, pos);
          const lines = prefix.split("\n");
          line = lines.length;
          col = lines[lines.length - 1].length + 1;
        }
      }

      return [{ file: displayPath, line, col, severity: "error", message: msg }];
    }
  } catch {
    return [];
  }
}

/** Check Python files via python3 -m py_compile */
async function checkPython(filePath: string, displayPath: string): Promise<Diagnostic[]> {
  try {
    const res = await runExec("python3", ["-m", "py_compile", filePath], path.dirname(filePath), 5000);
    if (res.exitCode === 0) return [];

    const stderr = res.stderr || res.stdout;
    let line = 1;
    let col = 1;

    const lineMatch = stderr.match(/line (\d+)/i);
    if (lineMatch) {
      line = parseInt(lineMatch[1], 10) || 1;
    }

    const caretMatch = stderr.match(/\n([^\n]*\^)/);
    if (caretMatch) {
      const idx = caretMatch[1].indexOf("^");
      col = idx >= 0 ? idx + 1 : 1;
    }

    const msgMatch = stderr.match(/SyntaxError:\s*(.*)/);
    const message = msgMatch ? `SyntaxError: ${msgMatch[1].trim()}` : "Python syntax error";

    return [{ file: displayPath, line, col, severity: "error", message }];
  } catch {
    return [];
  }
}

/** Check Shell scripts via bash -n */
async function checkBash(filePath: string, displayPath: string): Promise<Diagnostic[]> {
  try {
    const res = await runExec("bash", ["-n", filePath], path.dirname(filePath), 5000);
    if (res.exitCode === 0) return [];

    const stderr = res.stderr || res.stdout;
    let line = 1;
    let col = 1;

    const lineMatch = stderr.match(/line (\d+):\s*(.*)$/m);
    let message = "Shell syntax error";
    if (lineMatch) {
      line = parseInt(lineMatch[1], 10) || 1;
      message = lineMatch[2].trim();
    }

    return [{ file: displayPath, line, col, severity: "error", message }];
  } catch {
    return [];
  }
}

/** Check HTML tag balance and inline JavaScript syntax */
async function checkHtml(filePath: string, displayPath: string): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  let content = "";
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch {
    return [];
  }

  // 1. Tag balance check
  try {
    const tagRegex = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z0-9\-]+)(?:\s+[^>]*?)?(\/?)>/g;
    const stack: Array<{ tag: string; line: number; col: number }> = [];
    let match: RegExpExecArray | null;

    while ((match = tagRegex.exec(content)) !== null) {
      const fullMatch = match[0];
      if (fullMatch.startsWith("<!--")) continue;

      const isClosing = match[1] === "/";
      const tagName = match[2].toLowerCase();
      const isSelfClosing = match[3] === "/" || VOID_HTML_TAGS.has(tagName);

      const before = content.slice(0, match.index);
      const lines = before.split("\n");
      const line = lines.length;
      const col = lines[lines.length - 1].length + 1;

      if (isSelfClosing) {
        continue;
      }

      if (!isClosing) {
        stack.push({ tag: tagName, line, col });
      } else {
        if (stack.length === 0) {
          diagnostics.push({
            file: displayPath,
            line,
            col,
            severity: "error",
            message: `Unexpected closing tag </${tagName}> without opening tag`,
          });
        } else {
          const top = stack.pop()!;
          if (top.tag !== tagName) {
            diagnostics.push({
              file: displayPath,
              line,
              col,
              severity: "error",
              message: `Mismatched closing tag </${tagName}>; expected </${top.tag}> opened at line ${top.line}`,
            });
          }
        }
      }
    }

    for (const unclosed of stack) {
      diagnostics.push({
        file: displayPath,
        line: unclosed.line,
        col: unclosed.col,
        severity: "error",
        message: `Unclosed tag <${unclosed.tag}>`,
      });
    }
  } catch {}

  // 2. Inline script check via node --check
  try {
    const scriptRegex = /<script(?:\s+[^>]*)?>([\s\S]*?)<\/script>/gi;
    let sMatch: RegExpExecArray | null;
    let scriptIdx = 0;

    while ((sMatch = scriptRegex.exec(content)) !== null) {
      const openTag = sMatch[0].slice(0, sMatch[0].indexOf(">") + 1);
      // Skip non-javascript scripts (e.g. type="text/template" or type="application/json")
      const typeMatch = openTag.match(/\btype\s*=\s*["']([^"']+)["']/i);
      if (typeMatch) {
        const t = typeMatch[1].toLowerCase();
        if (t !== "text/javascript" && t !== "application/javascript" && t !== "module" && t !== "") {
          continue;
        }
      }

      const scriptBody = sMatch[1];
      if (!scriptBody.trim()) continue;

      const before = content.slice(0, sMatch.index);
      const openTagLines = openTag.split("\n").length - 1;
      const startLine = before.split("\n").length + openTagLines;

      const padded = "\n".repeat(Math.max(0, startLine - 1)) + scriptBody;
      const tmpFile = path.join(os.tmpdir(), `check_${Date.now()}_${scriptIdx++}.js`);
      try {
        await fs.writeFile(tmpFile, padded, "utf-8");
        const res = await runExec("node", ["--check", tmpFile], os.tmpdir(), 5000);
        if (res.exitCode !== 0) {
          const stderr = res.stderr || res.stdout;
          const lineMatch = stderr.match(/:(\d+)(?::(\d+))?\n([^\n]*)\n([^\n]*\^)/m);
          let errLine = startLine;
          let errCol = 1;
          if (lineMatch) {
            errLine = parseInt(lineMatch[1], 10) || startLine;
            const caretIdx = lineMatch[4].indexOf("^");
            errCol = caretIdx >= 0 ? caretIdx + 1 : 1;
          }
          const msgMatch = stderr.match(/^(?:[A-Za-z]+Error|Error):\s*(.*)$/m);
          const message = msgMatch ? `Inline script error: ${msgMatch[0].trim()}` : "Inline script syntax error";
          diagnostics.push({ file: displayPath, line: errLine, col: errCol, severity: "error", message });
        }
      } finally {
        await fs.rm(tmpFile, { force: true }).catch(() => {});
      }
    }
  } catch {}

  return diagnostics;
}

/** Check TypeScript files via tsc --noEmit if typescript is present in node_modules */
async function checkTypeScript(
  tsChangedFiles: Array<{ absPath: string; displayPath: string }>,
  workspaceRoot: string
): Promise<Diagnostic[]> {
  try {
    const tscBinLocal = path.join(workspaceRoot, "node_modules", ".bin", "tsc");
    const tsPkgDir = path.join(workspaceRoot, "node_modules", "typescript");

    let tscExists = false;
    try {
      await fs.access(tsPkgDir);
      tscExists = true;
    } catch {
      tscExists = false;
    }

    if (!tscExists) {
      return [];
    }

    let binCmd = "npx";
    let binArgs = ["--no-install", "tsc", "--noEmit"];
    try {
      await fs.access(tscBinLocal);
      binCmd = tscBinLocal;
      binArgs = ["--noEmit"];
    } catch {}

    const res = await runExec(binCmd, binArgs, workspaceRoot, 20_000);
    if (res.exitCode === 0) return [];

    const output = (res.stdout || "") + "\n" + (res.stderr || "");
    const lines = output.split("\n");
    const diagnostics: Diagnostic[] = [];

    const changedPathsNormalized = new Set(
      tsChangedFiles.map((f) => path.normalize(f.absPath))
    );

    for (const line of lines) {
      if (diagnostics.length >= 20) break;

      // Matches: file.ts(12,5): error TS2322: Message
      // or: file.ts:12:5 - error TS2322: Message
      const match = line.match(/^([^\s(:]+)(?:\((\d+),(\d+)\)|:(\d+):(\d+))\s*(?:-\s*)?(error|warning)\s+([A-Z0-9]+:\s*.*)$/i);
      if (!match) continue;

      const rawFile = match[1];
      const lineNum = parseInt(match[2] || match[4], 10) || 1;
      const colNum = parseInt(match[3] || match[5], 10) || 1;
      const severity = match[6].toLowerCase() === "warning" ? "warning" : "error";
      const message = match[7].trim();

      const absErrorPath = path.resolve(workspaceRoot, rawFile);
      if (changedPathsNormalized.has(absErrorPath)) {
        const item = tsChangedFiles.find((f) => path.normalize(f.absPath) === absErrorPath);
        const displayPath = item ? item.displayPath : rawFile;
        diagnostics.push({
          file: displayPath,
          line: lineNum,
          col: colNum,
          severity,
          message,
        });
      }
    }

    return diagnostics;
  } catch {
    return [];
  }
}

/**
 * Run fast diagnostics on changed files.
 * Fails open if checkers or runtimes are missing.
 */
export async function runDiagnostics(
  changedAbsFiles: string[],
  workspaceRoot: string
): Promise<Diagnostic[]> {
  const allDiagnostics: Diagnostic[] = [];
  const tsFiles: Array<{ absPath: string; displayPath: string }> = [];

  for (const absPath of changedAbsFiles) {
    try {
      // If file was deleted or does not exist, skip
      await fs.access(absPath);
    } catch {
      continue;
    }

    const rel = path.relative(workspaceRoot, absPath);
    const displayPath = rel.startsWith("..") ? absPath : rel;
    const ext = path.extname(absPath).toLowerCase();

    if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
      const diags = await checkJavaScript(absPath, displayPath);
      allDiagnostics.push(...diags);
    } else if (ext === ".json") {
      const diags = await checkJson(absPath, displayPath);
      allDiagnostics.push(...diags);
    } else if (ext === ".py") {
      const diags = await checkPython(absPath, displayPath);
      allDiagnostics.push(...diags);
    } else if (ext === ".sh") {
      const diags = await checkBash(absPath, displayPath);
      allDiagnostics.push(...diags);
    } else if (ext === ".html" || ext === ".htm") {
      const diags = await checkHtml(absPath, displayPath);
      allDiagnostics.push(...diags);
    } else if (ext === ".ts" || ext === ".tsx") {
      tsFiles.push({ absPath, displayPath });
    }
  }

  if (tsFiles.length > 0) {
    const tsDiags = await checkTypeScript(tsFiles, workspaceRoot);
    allDiagnostics.push(...tsDiags);
  }

  return allDiagnostics;
}
