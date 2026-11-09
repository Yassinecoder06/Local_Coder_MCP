import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createTestEnvironment } from "./helpers.js";
import {
  readTool,
  listTool,
  checkpointsTool,
  editFilesTool,
} from "../src/tools/files.js";

test("files tools: read, list, checkpoints, edit_files", async (t) => {
  const env = await createTestEnvironment();

  t.after(async () => {
    await env.cleanup();
  });

  await t.test("write and read single and multiple files via edit_files", async () => {
    const file1 = "hello.txt";
    const content1 = "Line 1\nLine 2\nLine 3\nLine 4\nLine 5";

    const writeRes = await editFilesTool.handler(
      {
        operations: [{ op: "write", path: file1, content: content1 }],
      },
      env.ctx
    );
    assert.equal(writeRes.ok, true);
    assert.ok(writeRes.data?.checkpoint_id);

    // Read full file
    const readRes = await readTool.handler({ paths: [file1] }, env.ctx);
    assert.equal(readRes.ok, true);
    assert.equal(readRes.data.files.length, 1);
    assert.match(readRes.data.files[0].content, /1 \| Line 1/);
    assert.match(readRes.data.files[0].content, /5 \| Line 5/);

    // Read with offset and limit
    const readSliceRes = await readTool.handler(
      { path: file1, offset: 2, limit: 2 },
      env.ctx
    );
    assert.equal(readSliceRes.ok, true);
    const content = readSliceRes.data.files[0].content;
    assert.match(content, /2 \| Line 2/);
    assert.match(content, /3 \| Line 3/);
    assert.doesNotMatch(content, /1 \| Line 1/);
    assert.doesNotMatch(content, /4 \| Line 4/);
  });

  await t.test("read: glob expansion ignores node_modules and dist", async () => {
    await fs.writeFile(path.join(env.workspaceDir, "glob-one.test"), "one");
    await fs.writeFile(path.join(env.workspaceDir, "glob-two.test"), "two");
    await fs.mkdir(path.join(env.workspaceDir, "node_modules"), { recursive: true });
    await fs.writeFile(path.join(env.workspaceDir, "node_modules", "glob-ignored.test"), "ignored");

    const res = await readTool.handler({ paths: ["*.test"] }, env.ctx);
    assert.equal(res.ok, true);
    assert.equal(res.data.files.length, 2);
    assert.ok(res.data.files.some((f: any) => f.path.includes("glob-one.test")));
    assert.ok(res.data.files.some((f: any) => f.path.includes("glob-two.test")));
    assert.ok(!res.data.files.some((f: any) => f.path.includes("node_modules")));
  });

  await t.test("read: directory path lists contents one level deep", async () => {
    const dirName = "test-read-dir";
    await fs.mkdir(path.join(env.workspaceDir, dirName, "sub"), { recursive: true });
    await fs.writeFile(path.join(env.workspaceDir, dirName, "alpha.txt"), "alpha");
    await fs.writeFile(path.join(env.workspaceDir, dirName, "beta.txt"), "beta");

    const res = await readTool.handler({ path: dirName }, env.ctx);
    assert.equal(res.ok, true);
    assert.equal(res.data.files.length, 1);
    assert.equal(res.data.files[0].type, "directory");
    assert.match(res.data.files[0].content, /sub\//);
    assert.match(res.data.files[0].content, /alpha\.txt/);
    assert.match(res.data.files[0].content, /beta\.txt/);
  });

  await t.test("read: truncates files exceeding 256 KB and calls exceeding 512 KB", async () => {
    // 300 KB file (exceeds 256 KB per-file cap)
    const bigFile = "big-file.txt";
    await fs.writeFile(path.join(env.workspaceDir, bigFile), "X".repeat(300 * 1024));

    const res = await readTool.handler({ path: bigFile }, env.ctx);
    assert.equal(res.ok, true);
    assert.match(res.data.files[0].content, /truncated: file exceeded 256 KB limit/);

    // Multiple 200 KB files exceeding 512 KB total
    const f1 = "multi-1.txt";
    const f2 = "multi-2.txt";
    const f3 = "multi-3.txt";
    await fs.writeFile(path.join(env.workspaceDir, f1), "A".repeat(200 * 1024));
    await fs.writeFile(path.join(env.workspaceDir, f2), "B".repeat(200 * 1024));
    await fs.writeFile(path.join(env.workspaceDir, f3), "C".repeat(200 * 1024));

    const multiRes = await readTool.handler({ paths: [f1, f2, f3] }, env.ctx);
    assert.equal(multiRes.ok, true);
    const combined = multiRes.data.files.map((f: any) => f.content).join("\n");
    assert.match(combined, /truncated to 512 KB per call limit/);
  });

  await t.test("list directory structure", async () => {
    await fs.mkdir(path.join(env.workspaceDir, "subdir"), { recursive: true });
    await fs.writeFile(path.join(env.workspaceDir, "subdir", "nested.txt"), "nested content");

    const listRes = await listTool.handler({ depth: 2 }, env.ctx);
    assert.equal(listRes.ok, true);
    assert.ok(listRes.data.entries.some((e: any) => e.name === "hello.txt"));
    assert.ok(listRes.data.entries.some((e: any) => e.name === "subdir"));
    assert.ok(listRes.data.entries.some((e: any) => e.name === "nested.txt"));
  });

  await t.test("edit_files: replace with single and multiple replacements", async () => {
    const editFile = "edit-me.txt";
    await editFilesTool.handler(
      {
        operations: [{ op: "write", path: editFile, content: "apple banana apple cherry" }],
      },
      env.ctx
    );

    // Multiple replacements in one call
    const editRes = await editFilesTool.handler(
      {
        operations: [
          { op: "replace", path: editFile, old: "apple", new: "orange" }, // first occurrence only
          { op: "replace", path: editFile, old: "cherry", new: "grape" },
        ],
      },
      env.ctx
    );
    assert.equal(editRes.ok, true);

    const check = await fs.readFile(path.join(env.workspaceDir, editFile), "utf-8");
    assert.equal(check, "orange banana apple grape");

    // Replace all
    const replaceAllRes = await editFilesTool.handler(
      {
        operations: [
          { op: "replace", path: editFile, old: "orange", new: "kiwi", replace_all: true },
        ],
      },
      env.ctx
    );
    assert.equal(replaceAllRes.ok, true);

    // Test error on missing text
    const failRes = await editFilesTool.handler(
      {
        operations: [
          { op: "replace", path: editFile, old: "non-existent-text", new: "test" },
        ],
      },
      env.ctx
    );
    assert.equal(failRes.ok, false);
    assert.match(failRes.error ?? "", /exact text not found/);
  });

  await t.test("checkpoints listing and edit_files undo restores previous checkpoint", async () => {
    const undoFile = "undo-me.txt";
    await editFilesTool.handler(
      { operations: [{ op: "write", path: undoFile, content: "version 1" }] },
      env.ctx
    );

    // Modify file
    const editRes = await editFilesTool.handler(
      { operations: [{ op: "write", path: undoFile, content: "version 2" }] },
      env.ctx
    );
    const cpId = editRes.data?.checkpoint_id;
    assert.ok(cpId);

    // Verify current content
    let content = await fs.readFile(path.join(env.workspaceDir, undoFile), "utf-8");
    assert.equal(content, "version 2");

    // List checkpoints using checkpoints read tool
    const listCp = await checkpointsTool.handler({}, env.ctx);
    assert.equal(listCp.ok, true);
    assert.ok(listCp.data.checkpoints.length > 0);

    // Restore checkpoint using edit_files with op: "undo"
    const restoreRes = await editFilesTool.handler(
      { operations: [{ op: "undo", checkpoint_id: cpId }] },
      env.ctx
    );
    assert.equal(restoreRes.ok, true);

    content = await fs.readFile(path.join(env.workspaceDir, undoFile), "utf-8");
    assert.equal(content, "version 1");
  });

  await t.test("edit_files: move, copy, delete, mkdir", async () => {
    const base = "fileops-test.txt";
    await editFilesTool.handler(
      { operations: [{ op: "write", path: base, content: "ops content" }] },
      env.ctx
    );

    // Move
    const moveRes = await editFilesTool.handler(
      {
        operations: [{ op: "move", path: base, to: "moved.txt" }],
      },
      env.ctx
    );
    assert.equal(moveRes.ok, true);
    await assert.rejects(fs.access(path.join(env.workspaceDir, base)));
    assert.ok(await fs.access(path.join(env.workspaceDir, "moved.txt")).then(() => true));

    // Copy
    const copyRes = await editFilesTool.handler(
      {
        operations: [{ op: "copy", path: "moved.txt", to: "copied.txt" }],
      },
      env.ctx
    );
    assert.equal(copyRes.ok, true);
    assert.ok(await fs.access(path.join(env.workspaceDir, "copied.txt")).then(() => true));

    // Delete
    const deleteRes = await editFilesTool.handler(
      {
        operations: [{ op: "delete", path: "copied.txt" }],
      },
      env.ctx
    );
    assert.equal(deleteRes.ok, true);
    await assert.rejects(fs.access(path.join(env.workspaceDir, "copied.txt")));

    // Mkdir
    const mkdirRes = await editFilesTool.handler(
      {
        operations: [{ op: "mkdir", path: "new-dir/sub" }],
      },
      env.ctx
    );
    assert.equal(mkdirRes.ok, true);
    assert.ok(await fs.access(path.join(env.workspaceDir, "new-dir/sub")).then(() => true));
  });

  await t.test("edit_files: top-level patch and operations patch", async () => {
    // 1. Begin Patch format via top-level patch shorthand: Add and Update
    const patch1 = `*** Begin Patch
*** Add File: patch-add.txt
+First line added
+Second line added
*** End Patch`;

    const res1 = await editFilesTool.handler({ patch: patch1 }, env.ctx);
    assert.equal(res1.ok, true);

    const addedContent = await fs.readFile(path.join(env.workspaceDir, "patch-add.txt"), "utf-8");
    assert.equal(addedContent, "First line added\nSecond line added");

    // 2. Update existing file via operations array
    const patch2 = `*** Begin Patch
*** Update File: patch-add.txt
@@ -1,2 +1,3 @@
 First line added
+Middle line inserted
 Second line added
*** End Patch`;

    const res2 = await editFilesTool.handler(
      { operations: [{ op: "patch", patch: patch2 }] },
      env.ctx
    );
    assert.equal(res2.ok, true);

    const updatedContent = await fs.readFile(path.join(env.workspaceDir, "patch-add.txt"), "utf-8");
    assert.equal(updatedContent, "First line added\nMiddle line inserted\nSecond line added");

    // 3. Move file in patch
    const patch3 = `*** Begin Patch
*** Move File: patch-add.txt -> patch-moved.txt
*** End Patch`;

    const res3 = await editFilesTool.handler({ patch: patch3 }, env.ctx);
    assert.equal(res3.ok, true);
    assert.ok(await fs.access(path.join(env.workspaceDir, "patch-moved.txt")).then(() => true));
    await assert.rejects(fs.access(path.join(env.workspaceDir, "patch-add.txt")));

    // 4. Delete file in patch
    const patch4 = `*** Begin Patch
*** Delete File: patch-moved.txt
*** End Patch`;

    const res4 = await editFilesTool.handler({ patch: patch4 }, env.ctx);
    assert.equal(res4.ok, true);
    await assert.rejects(fs.access(path.join(env.workspaceDir, "patch-moved.txt")));
  });
});
