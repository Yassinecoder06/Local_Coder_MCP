import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createTestEnvironment } from "./helpers.js";
import {
  readTool,
  listTool,
  writeTool,
  editTool,
  applyPatchTool,
  fileOpsTool,
  undoTool,
} from "../src/tools/files.js";

test("files tools: write, read, list, edit, undo, file_ops, apply_patch", async (t) => {
  const env = await createTestEnvironment();

  t.after(async () => {
    await env.cleanup();
  });

  await t.test("write and read single and multiple files", async () => {
    const file1 = "hello.txt";
    const content1 = "Line 1\nLine 2\nLine 3\nLine 4\nLine 5";

    const writeRes = await writeTool.handler({ path: file1, content: content1 }, env.ctx);
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

  await t.test("list directory structure", async () => {
    await fs.mkdir(path.join(env.workspaceDir, "subdir"), { recursive: true });
    await fs.writeFile(path.join(env.workspaceDir, "subdir", "nested.txt"), "nested content");

    const listRes = await listTool.handler({ depth: 2 }, env.ctx);
    assert.equal(listRes.ok, true);
    assert.ok(listRes.data.entries.some((e: any) => e.name === "hello.txt"));
    assert.ok(listRes.data.entries.some((e: any) => e.name === "subdir"));
    assert.ok(listRes.data.entries.some((e: any) => e.name === "nested.txt"));
  });

  await t.test("edit file with single and multiple replacements", async () => {
    const editFile = "edit-me.txt";
    await writeTool.handler(
      { path: editFile, content: "apple banana apple cherry" },
      env.ctx
    );

    // Multiple edits
    const editRes = await editTool.handler(
      {
        path: editFile,
        edits: [
          { old: "apple", new: "orange" }, // first occurrence only
          { old: "cherry", new: "grape" },
        ],
      },
      env.ctx
    );
    assert.equal(editRes.ok, true);

    const check = await fs.readFile(path.join(env.workspaceDir, editFile), "utf-8");
    assert.equal(check, "orange banana apple grape");

    // Replace all
    const replaceAllRes = await editTool.handler(
      {
        path: editFile,
        edits: [{ old: "orange", new: "kiwi", replace_all: true }],
      },
      env.ctx
    );
    assert.equal(replaceAllRes.ok, true);

    // Test error on missing text
    const failRes = await editTool.handler(
      {
        path: editFile,
        edits: [{ old: "non-existent-text", new: "test" }],
      },
      env.ctx
    );
    assert.equal(failRes.ok, false);
    assert.match(failRes.error ?? "", /exact text not found/);
  });

  await t.test("undo restores previous checkpoint", async () => {
    const undoFile = "undo-me.txt";
    await writeTool.handler({ path: undoFile, content: "version 1" }, env.ctx);

    // Modify file
    const editRes = await writeTool.handler({ path: undoFile, content: "version 2" }, env.ctx);
    const cpId = editRes.data.checkpoint_id;
    assert.ok(cpId);

    // Verify current content
    let content = await fs.readFile(path.join(env.workspaceDir, undoFile), "utf-8");
    assert.equal(content, "version 2");

    // List checkpoints
    const listCp = await undoTool.handler({}, env.ctx);
    assert.equal(listCp.ok, true);
    assert.ok(listCp.data.checkpoints.length > 0);

    // Restore checkpoint
    const restoreRes = await undoTool.handler({ checkpoint_id: cpId }, env.ctx);
    assert.equal(restoreRes.ok, true);

    content = await fs.readFile(path.join(env.workspaceDir, undoFile), "utf-8");
    assert.equal(content, "version 1");
  });

  await t.test("file_ops: move, copy, delete, mkdir", async () => {
    const base = "fileops-test.txt";
    await writeTool.handler({ path: base, content: "ops content" }, env.ctx);

    // Move
    const moveRes = await fileOpsTool.handler(
      {
        operations: [{ op: "move", src: base, dest: "moved.txt" }],
      },
      env.ctx
    );
    assert.equal(moveRes.ok, true);
    await assert.rejects(fs.access(path.join(env.workspaceDir, base)));
    assert.ok(await fs.access(path.join(env.workspaceDir, "moved.txt")).then(() => true));

    // Copy
    const copyRes = await fileOpsTool.handler(
      {
        operations: [{ op: "copy", src: "moved.txt", dest: "copied.txt" }],
      },
      env.ctx
    );
    assert.equal(copyRes.ok, true);
    assert.ok(await fs.access(path.join(env.workspaceDir, "copied.txt")).then(() => true));

    // Delete
    const deleteRes = await fileOpsTool.handler(
      {
        operations: [{ op: "delete", path: "copied.txt" }],
      },
      env.ctx
    );
    assert.equal(deleteRes.ok, true);
    await assert.rejects(fs.access(path.join(env.workspaceDir, "copied.txt")));
  });

  await t.test("apply_patch: *** Begin Patch format and unified diff", async () => {
    // 1. Begin Patch format: Add and Update
    const patch1 = `*** Begin Patch
*** Add File: patch-add.txt
+First line added
+Second line added
*** End Patch`;

    const res1 = await applyPatchTool.handler({ patch: patch1 }, env.ctx);
    assert.equal(res1.ok, true);

    const addedContent = await fs.readFile(path.join(env.workspaceDir, "patch-add.txt"), "utf-8");
    assert.equal(addedContent, "First line added\nSecond line added");

    // 2. Update existing file
    const patch2 = `*** Begin Patch
*** Update File: patch-add.txt
@@ -1,2 +1,3 @@
 First line added
+Middle line inserted
 Second line added
*** End Patch`;

    const res2 = await applyPatchTool.handler({ patch: patch2 }, env.ctx);
    assert.equal(res2.ok, true);

    const updatedContent = await fs.readFile(path.join(env.workspaceDir, "patch-add.txt"), "utf-8");
    assert.equal(updatedContent, "First line added\nMiddle line inserted\nSecond line added");

    // 3. Move file in patch
    const patch3 = `*** Begin Patch
*** Move File: patch-add.txt -> patch-moved.txt
*** End Patch`;

    const res3 = await applyPatchTool.handler({ patch: patch3 }, env.ctx);
    assert.equal(res3.ok, true);
    assert.ok(await fs.access(path.join(env.workspaceDir, "patch-moved.txt")).then(() => true));
    await assert.rejects(fs.access(path.join(env.workspaceDir, "patch-add.txt")));

    // 4. Delete file in patch
    const patch4 = `*** Begin Patch
*** Delete File: patch-moved.txt
*** End Patch`;

    const res4 = await applyPatchTool.handler({ patch: patch4 }, env.ctx);
    assert.equal(res4.ok, true);
    await assert.rejects(fs.access(path.join(env.workspaceDir, "patch-moved.txt")));
  });
});
