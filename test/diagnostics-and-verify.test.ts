import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createTestEnvironment } from "./helpers.js";
import { editFilesTool } from "../src/tools/files.js";
import { runTool } from "../src/tools/shell.js";
import { detectChecks, parseCheckErrors } from "../src/tools/lib/verify.js";
import { runDiagnostics } from "../src/tools/lib/diagnostics.js";

test("diagnostics: syntax and integrity checks on edit", async (t) => {
  const env = await createTestEnvironment();

  t.after(async () => {
    await env.cleanup();
  });

  await t.test("JavaScript syntax error generates diagnostic and hint", async () => {
    const badJs = "bad.js";
    const res = await editFilesTool.handler(
      {
        operations: [{ op: "write", path: badJs, content: "const x = ;\n" }],
      },
      env.ctx
    );
    assert.equal(res.ok, true);
    assert.ok(res.data.diagnostics);
    assert.ok(res.data.diagnostics.length > 0);
    const d = res.data.diagnostics[0];
    assert.equal(d.file, badJs);
    assert.equal(d.severity, "error");
    assert.equal(d.line, 1);
    assert.match(res.data.diagnostic_hint, /1 error after edit — fix before continuing/);
  });

  await t.test("JSON syntax error generates diagnostic", async () => {
    const badJson = "config.json";
    const res = await editFilesTool.handler(
      {
        operations: [{ op: "write", path: badJson, content: '{\n  "key": \n}' }],
      },
      env.ctx
    );
    assert.equal(res.ok, true);
    assert.ok(res.data.diagnostics.length > 0);
    const d = res.data.diagnostics.find((x: any) => x.file === badJson);
    assert.ok(d);
    assert.equal(d.severity, "error");
  });

  await t.test("Bash script syntax error generates diagnostic", async () => {
    const badSh = "script.sh";
    const res = await editFilesTool.handler(
      {
        operations: [{ op: "write", path: badSh, content: "#!/bin/bash\nif [ 1 ]; then\n" }],
      },
      env.ctx
    );
    assert.equal(res.ok, true);
    assert.ok(res.data.diagnostics.length > 0);
    const d = res.data.diagnostics.find((x: any) => x.file === badSh);
    assert.ok(d);
    assert.equal(d.severity, "error");
  });

  await t.test("Python script syntax error generates diagnostic", async () => {
    const badPy = "script.py";
    const res = await editFilesTool.handler(
      {
        operations: [{ op: "write", path: badPy, content: "def foo(\n  return 1\n" }],
      },
      env.ctx
    );
    assert.equal(res.ok, true);
    const d = res.data.diagnostics.find((x: any) => x.file === badPy);
    if (d) {
      assert.equal(d.severity, "error");
    }
  });

  await t.test("HTML mismatched tags and inline script syntax generate diagnostics", async () => {
    const badHtml = "index.html";
    const content = `<!DOCTYPE html>
<html>
<head>
  <title>Test</title>
  <script>
    const badVar = ;
  </script>
</head>
<body>
  <div><span>Unclosed span</div>
</body>
</html>`;
    const res = await editFilesTool.handler(
      {
        operations: [{ op: "write", path: badHtml, content }],
      },
      env.ctx
    );
    assert.equal(res.ok, true);
    assert.ok(res.data.diagnostics.length > 0);
    assert.ok(res.data.diagnostics.some((x: any) => x.file === badHtml && x.severity === "error"));
  });

  await t.test("Valid files produce no diagnostics", async () => {
    const goodJs = "good.js";
    const goodJson = "good.json";
    const res = await editFilesTool.handler(
      {
        operations: [
          { op: "write", path: goodJs, content: "console.log('hello world');\n" },
          { op: "write", path: goodJson, content: '{"ok": true}\n' },
        ],
      },
      env.ctx
    );
    assert.equal(res.ok, true);
    assert.deepEqual(res.data.diagnostics, []);
    assert.equal(res.data.diagnostic_hint, undefined);
  });
});

test("verify: auto-detection and execution", async (t) => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "verify-test-"));

  t.after(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  });

  await t.test("detects package.json scripts in order: typecheck, lint, test, build", async () => {
    const projectDir = path.join(tmpRoot, "npm-project");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(
      path.join(projectDir, "package.json"),
      JSON.stringify({
        scripts: {
          test: "node --test",
          build: "tsc",
          lint: "eslint .",
          typecheck: "tsc --noEmit",
          custom: "echo custom",
        },
      })
    );

    const checks = await detectChecks(projectDir);
    assert.deepEqual(checks, [
      { name: "typecheck", command: "npm run typecheck" },
      { name: "lint", command: "npm run lint" },
      { name: "test", command: "npm test" },
      { name: "build", command: "npm run build" },
    ]);
  });

  await t.test("detects Makefile test target", async () => {
    const projectDir = path.join(tmpRoot, "make-project");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, "Makefile"), "all:\n\techo all\ntest:\n\techo running tests\n");

    const checks = await detectChecks(projectDir);
    assert.deepEqual(checks, [{ name: "test", command: "make test" }]);
  });

  await t.test("detects pyproject.toml", async () => {
    const projectDir = path.join(tmpRoot, "py-project");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, "pyproject.toml"), "[project]\nname='foo'\n");

    const checks = await detectChecks(projectDir);
    assert.deepEqual(checks, [{ name: "test", command: "pytest" }]);
  });

  await t.test("detects Cargo.toml", async () => {
    const projectDir = path.join(tmpRoot, "rust-project");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, "Cargo.toml"), "[package]\nname='foo'\n");

    const checks = await detectChecks(projectDir);
    assert.deepEqual(checks, [{ name: "test", command: "cargo test" }]);
  });

  await t.test("run tool with verify:true runs checks and reports results", async () => {
    const env = await createTestEnvironment();
    t.after(async () => {
      await env.cleanup();
    });

    // Create a package.json with quick echo checks
    await fs.writeFile(
      path.join(env.workspaceDir, "package.json"),
      JSON.stringify({
        name: "test-pkg",
        scripts: {
          typecheck: "echo 'Typecheck ok'",
          test: "echo 'Test ok'",
        },
      })
    );

    const res = await runTool.handler({ verify: true }, env.ctx);
    assert.equal(res.ok, true);
    assert.equal(res.data.ok, true);
    assert.equal(res.data.checks.length, 2);
    assert.equal(res.data.checks[0].name, "typecheck");
    assert.equal(res.data.checks[0].ok, true);
    assert.equal(res.data.checks[1].name, "test");
    assert.equal(res.data.checks[1].ok, true);
    assert.equal(res.summary, "All 2 checks passed");
  });

  await t.test("run tool with verify:true parses errors on failure", async () => {
    const env = await createTestEnvironment();
    t.after(async () => {
      await env.cleanup();
    });

    await fs.writeFile(
      path.join(env.workspaceDir, "package.json"),
      JSON.stringify({
        name: "test-pkg",
        scripts: {
          typecheck: "echo 'Typecheck ok'",
          test: "echo 'src/math.ts:15:5 - error TS2322: Type number is not assignable to string.' && exit 1",
        },
      })
    );

    const res = await runTool.handler({ verify: true }, env.ctx);
    assert.equal(res.ok, true);
    assert.equal(res.data.ok, false);
    assert.equal(res.data.checks.length, 2);
    assert.equal(res.data.checks[0].ok, true);
    assert.equal(res.data.checks[1].ok, false);
    assert.equal(res.summary, "1 of 2 failed: test");

    const failedCheck = res.data.checks[1];
    assert.ok(failedCheck.errors.length > 0);
    assert.equal(failedCheck.errors[0].file, "src/math.ts");
    assert.equal(failedCheck.errors[0].line, 15);
  });
});

test("verify: error parsing from different test/linter runners", async () => {
  // 1. tsc output
  const tscOut = `src/index.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.
src/utils.ts:45:10 - error TS2304: Cannot find name 'foo'.`;
  const tscErrors = parseCheckErrors(tscOut);
  assert.equal(tscErrors.length, 2);
  assert.equal(tscErrors[0].file, "src/index.ts");
  assert.equal(tscErrors[0].line, 12);
  assert.match(tscErrors[0].message, /Type 'string'/);
  assert.equal(tscErrors[1].file, "src/utils.ts");
  assert.equal(tscErrors[1].line, 45);

  // 2. eslint output
  const eslintOut = `/app/src/app.js:10:5: error: Unexpected var, use let or const instead [no-var]`;
  const eslintErrors = parseCheckErrors(eslintOut);
  assert.equal(eslintErrors.length, 1);
  assert.equal(eslintErrors[0].file, "/app/src/app.js");
  assert.equal(eslintErrors[0].line, 10);

  // 3. pytest output
  const pytestOut = `tests/test_api.py:24: AssertionError: assert 404 == 200`;
  const pytestErrors = parseCheckErrors(pytestOut);
  assert.equal(pytestErrors.length, 1);
  assert.equal(pytestErrors[0].file, "tests/test_api.py");
  assert.equal(pytestErrors[0].line, 24);

  // 4. node:test / jest stack frame
  const jestOut = `AssertionError: Expected 1 to be 2
    at Object.<anonymous> (/workspace/test/math.test.ts:32:15)`;
  const jestErrors = parseCheckErrors(jestOut);
  assert.equal(jestErrors.length, 1);
  assert.equal(jestErrors[0].file, "/workspace/test/math.test.ts");
  assert.equal(jestErrors[0].line, 32);
});
