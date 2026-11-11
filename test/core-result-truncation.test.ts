import test from "node:test";
import assert from "node:assert/strict";
import {
  toCallToolResult,
  truncateHeadTail,
  findUtf8HeadEnd,
  findUtf8TailStart,
  ok,
  fail,
} from "../src/core/result.js";
import { runTool, jobTool } from "../src/tools/shell.js";
import { jobManager } from "../src/tools/lib/jobs.js";
import { createTestEnvironment } from "./helpers.js";

test("result truncation: head + tail preservation, fast 10 MB performance, UTF-8 safety", async (t) => {
  const maxBytes = 60_000;

  await t.test("big single output (keeps head + tail + marker)", () => {
    const lines = Array.from({ length: 2000 }, (_, i) => `Line ${i + 1}: ${"a".repeat(50)}`).join("\n");
    const original = ok("run", "Completed command", {
      output: lines,
      exit_code: 0,
    });

    const res = toCallToolResult(original, maxBytes);
    assert.equal(res.isError, false);
    assert.equal(res.content[0].type, "text");

    const parsed = JSON.parse(res.content[0].text);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.tool, "run");
    assert.equal(parsed.summary, "Completed command");
    assert.equal(parsed.truncated, true);
    assert.ok(Array.isArray(parsed.truncation));
    assert.equal(parsed.truncation.length, 1);
    assert.equal(parsed.truncation[0].path, "data.output");
    assert.ok(parsed.truncation[0].keptBytes > 0);
    assert.ok(parsed.truncation[0].omittedBytes > 0);
    assert.equal(parsed.truncation[0].keptBytes + parsed.truncation[0].omittedBytes, Buffer.byteLength(lines, "utf-8"));

    // Check head, tail, and marker
    const output = parsed.data.output;
    assert.ok(output.startsWith("Line 1: "));
    assert.ok(output.includes("Line 2000: "));
    assert.match(output, /\n… \[\d+ bytes omitted — use job output \/ read with a range for the rest\] …\n/);

    // Byte length must be <= maxBytes
    assert.ok(Buffer.byteLength(res.content[0].text, "utf-8") <= maxBytes);

    // structuredContent must match the wire text envelope exactly
    assert.deepEqual(res.structuredContent, parsed);
  });

  await t.test("big batch (data.items[i].output truncated per item)", () => {
    const batchItems = Array.from({ length: 5 }, (_, i) => ({
      cmd: `echo "cmd ${i + 1}"`,
      exitCode: 0,
      status: "completed",
      output: Array.from({ length: 500 }, (_, j) => `[${i + 1}] output line ${j + 1}: ${"x".repeat(60)}`).join("\n"),
    }));

    const original = ok("run", "Command batch completed", { items: batchItems });
    const res = toCallToolResult(original, maxBytes);

    const parsed = JSON.parse(res.content[0].text);
    assert.equal(parsed.truncated, true);
    assert.ok(Array.isArray(parsed.truncation));
    assert.ok(parsed.truncation.length > 0);

    // Verify paths are data.items[i].output
    for (const tr of parsed.truncation) {
      assert.match(tr.path, /^data\.items\[\d+\]\.output$/);
      assert.ok(tr.keptBytes > 0);
      assert.ok(tr.omittedBytes > 0);
    }

    // All 5 items still exist in data.items
    assert.equal(parsed.data.items.length, 5);
    for (let i = 0; i < 5; i++) {
      const item = parsed.data.items[i];
      assert.equal(item.cmd, `echo "cmd ${i + 1}"`);
      assert.ok(item.output.includes(`[${i + 1}] output line 1:`));
      assert.ok(item.output.includes("…"));
    }

    assert.ok(Buffer.byteLength(res.content[0].text, "utf-8") <= maxBytes);
    assert.deepEqual(res.structuredContent, parsed);
  });

  await t.test("nested data.files (each file content truncated)", () => {
    const files = [
      {
        path: "src/one.ts",
        content: Array.from({ length: 1000 }, (_, i) => `// file one line ${i + 1}\nconst v${i} = "hello";`).join("\n"),
      },
      {
        path: "src/two.ts",
        content: Array.from({ length: 1000 }, (_, i) => `// file two line ${i + 1}\nconst w${i} = "world";`).join("\n"),
      },
    ];

    const original = ok("read", "Read 2 files", { files });
    const res = toCallToolResult(original, maxBytes);

    const parsed = JSON.parse(res.content[0].text);
    assert.equal(parsed.truncated, true);
    assert.ok(Array.isArray(parsed.truncation));

    // Paths are data.files[0].content and data.files[1].content
    const paths = parsed.truncation.map((t: { path: string }) => t.path);
    assert.ok(paths.includes("data.files[0].content"));
    assert.ok(paths.includes("data.files[1].content"));

    // Check content has head + tail + marker
    assert.ok(parsed.data.files[0].content.includes("// file one line 1"));
    assert.ok(parsed.data.files[0].content.includes("… ["));
    assert.ok(parsed.data.files[1].content.includes("// file two line 1"));
    assert.ok(parsed.data.files[1].content.includes("… ["));

    assert.ok(Buffer.byteLength(res.content[0].text, "utf-8") <= maxBytes);
    assert.deepEqual(res.structuredContent, parsed);
  });

  await t.test("giant array (keeps first and last items + { omitted: N })", () => {
    const giant = Array.from({ length: 2000 }, (_, i) => ({
      index: i + 1,
      name: `item_${i + 1}`,
      tag: `tag_${i % 10}`,
    }));

    const original = ok("search", "Found 2000 items", { results: giant });
    const res = toCallToolResult(original, 10_000);

    const parsed = JSON.parse(res.content[0].text);
    assert.equal(parsed.truncated, true);

    const results = parsed.data.results;
    assert.equal(results.length, 3);
    assert.deepEqual(results[0], { index: 1, name: "item_1", tag: "tag_0" });
    assert.deepEqual(results[1], { omitted: 1998 });
    assert.deepEqual(results[2], { index: 2000, name: "item_2000", tag: "tag_9" });

    assert.ok(Buffer.byteLength(res.content[0].text, "utf-8") <= 10_000);
    assert.deepEqual(res.structuredContent, parsed);
  });

  await t.test("10 MB string timing (< 200 ms)", () => {
    const tenMb = "Start of 10MB data\n" + "X".repeat(10_000_000) + "\nEnd of 10MB data";
    const original = ok("run", "Huge output", { output: tenMb });

    const start = performance.now();
    const res = toCallToolResult(original, maxBytes);
    const elapsed = performance.now() - start;

    assert.ok(elapsed < 200, `Expected < 200 ms, took ${elapsed.toFixed(2)} ms`);

    const parsed = JSON.parse(res.content[0].text);
    assert.equal(parsed.truncated, true);
    assert.equal(parsed.truncation[0].path, "data.output");
    assert.ok(parsed.data.output.startsWith("Start of 10MB data"));
    assert.ok(parsed.data.output.endsWith("End of 10MB data"));
    assert.match(parsed.data.output, /… \[\d+ bytes omitted — use job output \/ read with a range for the rest\] …/);

    assert.ok(Buffer.byteLength(res.content[0].text, "utf-8") <= maxBytes);
  });

  await t.test("UTF-8 multi-byte boundaries (no corruption or replacement characters)", () => {
    // 4-byte rocket emojis, 3-byte CJK, 2-byte accents
    const multiByteUnits = "🚀 Rocket \u4E2D\u6587 Chinese \u00E9 accent \n";
    const content = multiByteUnits.repeat(3000); // ~120 KB

    const original = ok("run", "Unicode output", { output: content });
    const res = toCallToolResult(original, 20_000);

    const parsed = JSON.parse(res.content[0].text);
    assert.equal(parsed.truncated, true);

    const output: string = parsed.data.output;
    // Must NOT contain replacement character \uFFFD
    assert.equal(output.includes("\uFFFD"), false, "Output contains unicode replacement character \uFFFD");
    assert.equal(res.content[0].text.includes("\uFFFD"), false, "JSON contains unicode replacement character \uFFFD");

    // Output must start with rocket and contain marker
    assert.ok(output.startsWith("🚀 Rocket"));
    assert.match(output, /… \[\d+ bytes omitted — use job output \/ read with a range for the rest\] …/);

    assert.ok(Buffer.byteLength(res.content[0].text, "utf-8") <= 20_000);
  });

  await t.test("truncateHeadTail unit tests: ratios, line snapping, and invariants", () => {
    // Exact byte length invariant: keptBytes + omittedBytes === original.length
    const sample = Array.from({ length: 50 }, (_, i) => `Line ${i + 1}: message ${i + 1}`).join("\n");
    const tr = truncateHeadTail(sample, 400, { headRatio: 0.6, tailRatio: 0.4 });
    assert.equal(tr.keptBytes + tr.omittedBytes, Buffer.byteLength(sample, "utf-8"));
    assert.ok(Buffer.byteLength(tr.text, "utf-8") <= 400);
    assert.match(tr.text, /Line 1: message 1/);
    assert.match(tr.text, /Line 50: message 50/);
    assert.match(tr.text, /… \[\d+ bytes omitted — use job output \/ read with a range for the rest\] …/);

    // Line snapping snaps on newlines cleanly
    const lines = tr.text.split("\n");
    assert.equal(lines[0], "Line 1: message 1");
    assert.equal(lines[lines.length - 1], "Line 50: message 50");

    // No truncation when within budget
    const small = "short text";
    const smallTr = truncateHeadTail(small, 100);
    assert.equal(smallTr.text, small);
    assert.equal(smallTr.omittedBytes, 0);
    assert.equal(smallTr.keptBytes, Buffer.byteLength(small, "utf-8"));
  });

  await t.test("error preservation when result fails", () => {
    const bigErr = "Fatal crash: " + "E".repeat(100_000);
    const res = toCallToolResult(fail("run", bigErr, { output: "some output" }), maxBytes);

    const parsed = JSON.parse(res.content[0].text);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.tool, "run");
    assert.ok(parsed.error);
    assert.ok(Buffer.byteLength(res.content[0].text, "utf-8") <= maxBytes);
  });

  await t.test("result still valid JSON and <= maxBytes across various budgets", () => {
    const payloads = [
      { text: "Short text" },
      { text: "Large string: " + "Z".repeat(80_000) },
      { items: Array.from({ length: 50 }, (_, i) => ({ id: i, text: "A".repeat(500) })) },
      { files: [{ path: "f1", content: "B".repeat(40_000) }, { path: "f2", content: "C".repeat(40_000) }] },
      { list: Array.from({ length: 500 }, (_, i) => i) },
    ];

    const budgets = [500, 1000, 5000, 10_000, 60_000];

    for (const payload of payloads) {
      for (const budget of budgets) {
        const res = toCallToolResult(ok("test", "test summary", payload), budget);
        assert.equal(res.content[0].type, "text");
        const jsonText = res.content[0].text;
        const bytes = Buffer.byteLength(jsonText, "utf-8");
        assert.ok(bytes <= budget, `Expected bytes (${bytes}) <= budget (${budget})`);
        // Must parse as valid JSON
        assert.doesNotThrow(() => JSON.parse(jsonText));
      }
    }
  });
});

test("shell tools and jobs: head + tail truncation on capture limits", async (t) => {
  const env = await createTestEnvironment({ shellSyncMs: 5000 });

  t.after(async () => {
    for (const service of await jobManager.listServices()) {
      if (service.running) jobManager.stopService(String(service.name));
    }
    await env.cleanup();
  });

  await t.test("single command output exceeding maxOutputBytes keeps head and tail", async () => {
    // Produce 150 KB of output (exceeding 60 KB maxOutputBytes) fast
    const cmd = "node -e 'process.stdout.write(\"Step 1: payload line 1\\n\"); const chunk = (\"middle line \" + \"x\".repeat(70) + \"\\n\").repeat(50); for(let i=0;i<40;i++) process.stdout.write(chunk); process.stdout.write(\"Step 2000: payload line 2000\\n\");'";
    const res = await runTool.handler({ command: cmd }, env.ctx);

    assert.equal(res.ok, true);
    assert.equal(res.data.exit_code, 0);

    const output: string = res.data.output;
    assert.ok(output.includes("Step 1: payload line 1"));
    assert.ok(output.includes("Step 2000: payload line 2000"));
    assert.match(output, /… \[\d+ bytes omitted — use job output \/ read with a range for the rest\] …/);
    assert.ok(Buffer.byteLength(output, "utf-8") <= env.ctx.config.maxOutputBytes);
  });

  await t.test("cmds batch with item exceeding output budget preserves head and tail with exit code", async () => {
    // Produce 150 KB of output in item 1 (exceeding 60 KB budget) fast
    const cmds = [
      "echo 'first-small-cmd'",
      "node -e 'process.stdout.write(\"BatchStep 1: start\\n\"); const chunk = (\"BatchStep line \" + \"y\".repeat(70) + \"\\n\").repeat(50); for(let i=0;i<40;i++) process.stdout.write(chunk); console.error(\"ErrorAtEnd\"); process.exit(42);'",
      "echo 'third-cmd'",
    ];

    const res = await runTool.handler({ cmds }, env.ctx);
    assert.equal(res.ok, true);

    const items = res.data.items;
    assert.equal(items.length, 3);
    assert.equal(items[0].exitCode, 0);
    assert.equal(items[1].exitCode, 42);

    // Item 1 had large output and exit 42. Check that head and tail were preserved
    const item1Output: string = items[1].output;
    assert.ok(item1Output.includes("BatchStep 1: start"));
    assert.ok(item1Output.includes("ErrorAtEnd"));
    assert.ok(item1Output.includes("exit code: 42"));
    assert.match(item1Output, /… \[\d+ bytes omitted — use job output \/ read with a range for the rest\] …/);
  });

  await t.test("jobManager.getJobOutput with limitBytes keeps head and tail", async () => {
    const jobRes = await jobManager.startJob(
      "node -e 'for(let i=1;i<=1000;i++) console.log(`JobLine ${i}`);'",
      env.workspaceDir,
      1000
    );

    const full = jobManager.getJobOutput(jobRes.job_id);
    assert.ok(full.includes("JobLine 1"));
    assert.ok(full.includes("JobLine 1000"));

    // Query with limitBytes: 500
    const limited = jobManager.getJobOutput(jobRes.job_id, 500);
    assert.ok(Buffer.byteLength(limited, "utf-8") <= 500);
    assert.ok(limited.includes("JobLine 1"));
    assert.ok(limited.includes("JobLine 1000"));
    assert.match(limited, /… \[\d+ bytes omitted — use job output \/ read with a range for the rest\] …/);
  });
});
