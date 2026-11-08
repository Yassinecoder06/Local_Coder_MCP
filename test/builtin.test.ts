import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { createSkillRegistry } from "../src/skills/index.js";
import { createCommandRegistry } from "../src/commands/index.js";

test("builtin skills and commands validation", async (t) => {
  const rootDir = process.cwd();
  const config = loadConfig({
    BUILTIN_SKILLS_DIR: path.join(rootDir, "skills"),
    BUILTIN_COMMANDS_DIR: path.join(rootDir, "commands"),
    USER_SKILLS_DIR: path.join(rootDir, "data", "skills"),
    USER_COMMANDS_DIR: path.join(rootDir, "data", "commands"),
  });

  const settings = {
    get: () => ({ disabledSkills: [] }),
    update: async () => {},
  };

  const skillsRegistry = createSkillRegistry(config, settings);
  const commandsRegistry = createCommandRegistry(config);

  await t.test("all 6 built-in skills are present and valid", async () => {
    const skills = await skillsRegistry.list();
    const expected = ["herdr", "ui-design", "code-review", "git-workflow", "skill-authoring", "docker-dev"];

    for (const name of expected) {
      const skill = skills.find((s) => s.name === name);
      assert.ok(skill, `Expected skill "${name}" to be present`);
      assert.ok(skill.description.length > 10, `Skill "${name}" should have descriptive text`);
      assert.equal(skill.source, "builtin");

      const fullSkill = await skillsRegistry.get(name);
      assert.ok(fullSkill?.body.length > 50, `Skill "${name}" should have body content`);
    }
  });

  await t.test("all 15 built-in commands are present, valid, and renderable", async () => {
    const commands = await commandsRegistry.list();
    const expected = [
      "review",
      "test",
      "fix",
      "commit",
      "explain",
      "plan",
      "scaffold",
      "docs",
      "refactor",
      "deps",
      "onboard",
      "ship",
      "verify",
      "todo",
      "resume",
    ];

    for (const name of expected) {
      const cmd = commands.find((c) => c.name === name);
      assert.ok(cmd, `Expected command "${name}" to be present`);
      assert.ok(cmd.description.length > 10, `Command "${name}" should have descriptive text`);
      assert.equal(cmd.source, "builtin");

      const rendered = await commandsRegistry.render(name, {
        focus: "authentication",
        filter: "unit",
        issue: "memory leak",
        message: "fix: resolve memory leak",
        target: "JobManager",
        feature: "OAuth 2.1",
        name: "AuthService",
        topic: "REST API",
        action: "audit",
      });
      assert.ok(rendered.length > 20, `Rendered command "${name}" should have content`);
    }
  });
});
