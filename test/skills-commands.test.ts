import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createTestEnvironment } from "./helpers.js";
import { parseSkillFrontmatter } from "../src/skills/index.js";
import { parseCommandFrontmatter } from "../src/commands/index.js";
import { skillsListTool, skillLoadTool } from "../src/tools/skills.js";

test("skills registry: frontmatter parsing, priority, save, import, remove, traversal rejection", async (t) => {
  const env = await createTestEnvironment();

  t.after(async () => {
    await env.cleanup();
  });

  await t.test("frontmatter parser handles quoted and multiline descriptions", () => {
    const raw = `---
name: sample-skill
description: "A quoted description with special characters: like colons and dashes."
---
# Main instructions
Step 1. Do something.`;

    const parsed = parseSkillFrontmatter(raw);
    assert.equal(parsed.name, "sample-skill");
    assert.equal(parsed.description, "A quoted description with special characters: like colons and dashes.");
    assert.match(parsed.body, /# Main instructions/);

    // Block scalar description
    const rawBlock = `---
name: block-skill
description: >
  Line 1 of description
  Line 2 of description
---
Body text`;

    const parsedBlock = parseSkillFrontmatter(rawBlock);
    assert.equal(parsedBlock.name, "block-skill");
    assert.equal(parsedBlock.description, "Line 1 of description Line 2 of description");
  });

  await t.test("save user skill, list, get, and readFile", async () => {
    const saved = await env.ctx.skills.save({
      name: "custom-test-skill",
      description: "A test skill for unit testing",
      body: "# Instructions\nFollow these steps carefully.",
      files: {
        "reference.txt": "Some reference details",
      },
    });

    assert.equal(saved.name, "custom-test-skill");
    assert.equal(saved.source, "user");
    assert.equal(saved.editable, true);
    assert.ok(saved.files.includes("SKILL.md"));
    assert.ok(saved.files.includes("reference.txt"));

    // Get skill
    const skill = await env.ctx.skills.get("custom-test-skill");
    assert.ok(skill);
    assert.match(skill.body, /Follow these steps carefully/);

    // Read extra file
    const refContent = await env.ctx.skills.readFile("custom-test-skill", "reference.txt");
    assert.equal(refContent, "Some reference details");
  });

  await t.test("traversal rejection on readFile and save", async () => {
    // Attempt path traversal on readFile
    await assert.rejects(
      env.ctx.skills.readFile("custom-test-skill", "../../sensitive.txt"),
      /Path traversal/
    );

    // Attempt path traversal on save
    await assert.rejects(
      env.ctx.skills.save({
        name: "malicious-skill",
        description: "bad",
        body: "bad",
        files: {
          "../../evil.txt": "evil content",
        },
      }),
      /Path traversal/
    );
  });

  await t.test("importMarkdown and importFromPath", async () => {
    const markdown = `---
name: imported-skill
description: "Imported via markdown"
---
# Imported Body`;

    const summary = await env.ctx.skills.importMarkdown(markdown);
    assert.equal(summary.name, "imported-skill");

    const fetched = await env.ctx.skills.get("imported-skill");
    assert.ok(fetched);
    assert.match(fetched.body, /Imported Body/);
  });

  await t.test("skill priority: user shadows builtin", async () => {
    // Create a builtin skill folder in BUILTIN_SKILLS_DIR
    const builtinDir = path.join(env.skillsDir, "shadow-test");
    await fs.mkdir(builtinDir, { recursive: true });
    await fs.writeFile(
      path.join(builtinDir, "SKILL.md"),
      `---
name: shadow-test
description: "Builtin version"
---
Builtin body`
    );

    // Verify it lists as builtin
    let list = await env.ctx.skills.list();
    let found = list.find((s) => s.name === "shadow-test");
    assert.ok(found);
    assert.equal(found.source, "builtin");

    // Save a user skill with the same name
    await env.ctx.skills.save({
      name: "shadow-test",
      description: "User version overriding builtin",
      body: "User body override",
    });

    // Re-list and verify user source wins
    list = await env.ctx.skills.list();
    found = list.find((s) => s.name === "shadow-test");
    assert.ok(found);
    assert.equal(found.source, "user");
    assert.equal(found.description, "User version overriding builtin");
    assert.deepEqual(found.hides, ["builtin"]);
  });

  await t.test("skill shadowing visibility in skills_list, note on skill_load, and source argument", async () => {
    // 1. skills_list tool marks shadowed entries
    const listRes = await skillsListTool.handler({}, env.ctx);
    assert.equal(listRes.ok, true);
    assert.ok(listRes.data.entries.some((e: string) => e === "shadow-test (user; hides builtin)"));
    assert.match(listRes.summary, /shadow-test \(user; hides builtin\)/);

    // 2. skill_load default loads overriding version and appends note
    const loadDefault = await skillLoadTool.handler({ name: "shadow-test" }, env.ctx);
    assert.equal(loadDefault.ok, true);
    assert.equal(loadDefault.data.skill.source, "user");
    assert.match(loadDefault.data.skill.body, /User body override/);
    assert.match(
      loadDefault.data.skill.body,
      /Note: A builtin copy of this skill is shadowed\. Load it with skill_load\(\{ name: "shadow-test", source: "builtin" \}\)\./
    );
    assert.equal(
      loadDefault.data.note,
      'Note: A builtin copy of this skill is shadowed. Load it with skill_load({ name: "shadow-test", source: "builtin" }).'
    );
    assert.match(loadDefault.summary, /Note: A builtin copy of this skill is shadowed/);

    // 3. skill_load with source="builtin" loads shadowed builtin copy without note
    const loadBuiltin = await skillLoadTool.handler({ name: "shadow-test", source: "builtin" }, env.ctx);
    assert.equal(loadBuiltin.ok, true);
    assert.equal(loadBuiltin.data.skill.source, "builtin");
    assert.equal(loadBuiltin.data.skill.body, "Builtin body");
    assert.equal(loadBuiltin.data.note, undefined);

    // 4. skill_load with non-existent source fails cleanly
    const loadExtra = await skillLoadTool.handler({ name: "shadow-test", source: "extra" }, env.ctx);
    assert.equal(loadExtra.ok, false);
    assert.match(loadExtra.error, /not found/i);
  });

  await t.test("remove user skill and setEnabled", async () => {
    await env.ctx.skills.remove("custom-test-skill");
    const skill = await env.ctx.skills.get("custom-test-skill");
    assert.equal(skill, undefined);

    // setEnabled
    await env.ctx.skills.setEnabled("imported-skill", false);
    const listDisabled = await env.ctx.skills.list({ includeDisabled: false });
    assert.ok(!listDisabled.some((s) => s.name === "imported-skill"));

    const listAll = await env.ctx.skills.list({ includeDisabled: true });
    const disabledSkill = listAll.find((s) => s.name === "imported-skill");
    assert.ok(disabledSkill);
    assert.equal(disabledSkill.enabled, false);
  });
});

test("commands registry: parse, render, save, remove", async (t) => {
  const env = await createTestEnvironment();

  t.after(async () => {
    await env.cleanup();
  });

  await t.test("parse command frontmatter and args", () => {
    const raw = `---
name: sample-cmd
description: "Test command description"
args: [focus, target]
---
Please review {{focus}} and target {{target}}. Extra args: {{args}}.`;

    const parsed = parseCommandFrontmatter(raw);
    assert.equal(parsed.name, "sample-cmd");
    assert.equal(parsed.description, "Test command description");
    assert.deepEqual(parsed.args, ["focus", "target"]);
    assert.match(parsed.template, /Please review \{\{focus\}\}/);
  });

  await t.test("save, get, render with args, and remove command", async () => {
    const saved = await env.ctx.commands.save({
      name: "deploy-app",
      description: "Deploy the app to staging or prod",
      args: ["env", "tag"],
      template: "Deploying to {{env}} with image tag {{tag}}. Arguments: {{args}}.",
    });

    assert.equal(saved.name, "deploy-app");
    assert.equal(saved.source, "user");

    const cmd = await env.ctx.commands.get("deploy-app");
    assert.ok(cmd);
    assert.equal(cmd.name, "deploy-app");

    // Render with specific args
    const rendered = await env.ctx.commands.render("deploy-app", {
      env: "staging",
      tag: "v1.2.3",
    });
    assert.match(rendered, /Deploying to staging with image tag v1\.2\.3\./);

    // Remove
    await env.ctx.commands.remove("deploy-app");
    const afterRemove = await env.ctx.commands.get("deploy-app");
    assert.equal(afterRemove, undefined);
  });
});
