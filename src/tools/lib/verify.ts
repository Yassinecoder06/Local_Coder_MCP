import fs from "node:fs/promises";
import path from "node:path";

export interface CheckDefinition {
  name: string;
  command: string;
}

export interface CheckError {
  file: string;
  line: number;
  message: string;
}

export interface CheckResult {
  name: string;
  command: string;
  ok: boolean;
  exit_code: number;
  duration_ms: number;
  errors: CheckError[];
  tail: string;
}

/**
 * Auto-detect validation checks for a workspace.
 * Priority:
 * 1. package.json scripts.verify (alone), then typecheck, lint, test, build
 * 2. Makefile test
 * 3. pyproject.toml / pytest.ini / setup.py -> pytest
 * 4. Cargo.toml -> cargo test
 * 5. go.mod -> go test ./...
 */
export async function detectChecks(workspaceRoot: string): Promise<CheckDefinition[]> {
  const checks: CheckDefinition[] = [];

  // 1. package.json scripts
  try {
    const pkgPath = path.join(workspaceRoot, "package.json");
    const content = await fs.readFile(pkgPath, "utf-8");
    const pkg = JSON.parse(content);
    if (pkg.scripts && typeof pkg.scripts === "object") {
      if (typeof pkg.scripts.verify === "string" && pkg.scripts.verify.trim().length > 0) {
        return [{ name: "verify", command: "npm run verify" }];
      }
      const order = ["typecheck", "lint", "test", "build"];
      for (const script of order) {
        if (typeof pkg.scripts[script] === "string" && pkg.scripts[script].trim().length > 0) {
          checks.push({
            name: script,
            command: script === "test" ? "npm test" : `npm run ${script}`,
          });
        }
      }
    }
  } catch {}

  const hasTest = checks.some((c) => c.name === "test");
  if (hasTest) {
    return checks;
  }

  // 2. Makefile test
  try {
    const makefilePath = path.join(workspaceRoot, "Makefile");
    let content = "";
    try {
      content = await fs.readFile(makefilePath, "utf-8");
    } catch {
      content = await fs.readFile(path.join(workspaceRoot, "makefile"), "utf-8");
    }
    if (/^\s*test\s*:/m.test(content)) {
      checks.push({ name: "test", command: "make test" });
      return checks;
    }
  } catch {}

  // 3. Python pytest
  try {
    const candidates = ["pyproject.toml", "pytest.ini", "setup.py", "setup.cfg"];
    for (const c of candidates) {
      try {
        await fs.access(path.join(workspaceRoot, c));
        checks.push({ name: "test", command: "pytest" });
        return checks;
      } catch {}
    }
  } catch {}

  // 4. Cargo.toml (Rust)
  try {
    await fs.access(path.join(workspaceRoot, "Cargo.toml"));
    checks.push({ name: "test", command: "cargo test" });
    return checks;
  } catch {}

  // 5. go.mod (Go)
  try {
    await fs.access(path.join(workspaceRoot, "go.mod"));
    checks.push({ name: "test", command: "go test ./..." });
    return checks;
  } catch {}

  return checks;
}

/** Explain where detection looked and suggest nearby project roots when it was run one level too high. */
export async function noChecksMessage(workspaceRoot: string): Promise<string> {
  const children: string[] = [];
  try {
    const entries = await fs.readdir(workspaceRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const childPath = path.join(workspaceRoot, entry.name);
      for (const marker of ["package.json", "pyproject.toml", "Cargo.toml", "go.mod"]) {
        try {
          await fs.access(path.join(childPath, marker));
          children.push(entry.name);
          break;
        } catch { /* check the next marker */ }
      }
      if (children.length >= 5) break;
    }
  } catch { /* report the workspace even if it cannot be listed */ }

  const suggestions = children.length
    ? ` Did you mean cwd: ${children.map((child) => `'${child}'`).join(", ")}?`
    : "";
  return `No verification checks detected in '${workspaceRoot}'.${suggestions}`;
}

/**
 * Parse structured errors from command output (tsc, eslint, jest, vitest, node:test, pytest, and generic file:line:col).
 */
export function parseCheckErrors(output: string): CheckError[] {
  const errors: CheckError[] = [];
  const seen = new Set<string>();

  const add = (file: string, line: number, message: string) => {
    const cleanFile = file.trim().replace(/^[\(\[\{]/, "").replace(/[\)\]\}]$/, "");
    const cleanMsg = message.trim();
    if (!cleanFile || !cleanMsg) return;
    const key = `${cleanFile}:${line}:${cleanMsg}`;
    if (!seen.has(key)) {
      seen.add(key);
      errors.push({ file: cleanFile, line, message: cleanMsg });
    }
  };

  const lines = output.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 1. tsc: file.ts(12,5): error TS123: msg OR file.ts:12:5 - error TS123: msg
    const tscMatch = line.match(/^([^\s(:]+)(?:\((\d+),\d+\)|:(\d+):\d+):?\s*(?:-\s*)?error\s+[A-Z0-9]+:\s*(.*)$/i);
    if (tscMatch) {
      const file = tscMatch[1];
      const lineNum = parseInt(tscMatch[2] || tscMatch[3], 10) || 1;
      const msg = tscMatch[4];
      add(file, lineNum, msg);
      continue;
    }

    // 2. eslint / generic file:line:col error
    const eslintMatch = line.match(/^([^\s:]+\.[a-zA-Z0-9]+):(\d+)(?::\d+)?\s*[:\-]?\s*(?:error\s*:?)?\s*(.*)$/i);
    if (eslintMatch && /error|failed|syntax|unexpected/i.test(line)) {
      const file = eslintMatch[1];
      const lineNum = parseInt(eslintMatch[2], 10) || 1;
      const msg = eslintMatch[3] || line.trim();
      add(file, lineNum, msg);
      continue;
    }

    // 3. pytest: file.py:12: AssertionError: msg
    const pytestMatch = line.match(/^([^\s:]+\.py):(\d+):\s*(?:in\s+\w+:)?\s*(.*)$/i);
    if (pytestMatch && (line.includes("Error") || line.includes("FAILED"))) {
      const file = pytestMatch[1];
      const lineNum = parseInt(pytestMatch[2], 10) || 1;
      const msg = pytestMatch[3] || "Test failure";
      add(file, lineNum, msg);
      continue;
    }

    // 4. jest / vitest / node:test stack frame: at Object.<anonymous> (/path/to/test.ts:25:10)
    const stackMatch = line.match(/\bat (?:.*? \()?([^\s()]+\.[a-zA-Z0-9]+):(\d+):\d+\)?/);
    if (stackMatch && !stackMatch[1].includes("node_modules") && !stackMatch[1].startsWith("node:")) {
      const file = stackMatch[1];
      const lineNum = parseInt(stackMatch[2], 10) || 1;
      let msg = "Test assertion failed";
      for (let j = Math.max(0, i - 4); j < i; j++) {
        if (/error|failed|expected|assertion/i.test(lines[j])) {
          msg = lines[j].trim();
          break;
        }
      }
      add(file, lineNum, msg);
      continue;
    }
  }

  return errors;
}
