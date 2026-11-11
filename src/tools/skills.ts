import { z } from "zod";
import { defineTool, type ToolModule } from "../core/types.js";
import { ok, fail } from "../core/result.js";

export const skillsListTool = defineTool({
  name: "skills_list",
  title: "List Skills",
  description: "List available specialized skills with descriptions and source locations. Inspect available skills to choose relevant domain instructions.",
  group: "skills",
  risk: "read",
  input: {
    include_disabled: z
      .boolean()
      .default(false)
      .optional()
      .describe("Include disabled skills in listing (default false)"),
  },
  handler: async (args, ctx) => {
    try {
      const skills = await ctx.skills.list({
        includeDisabled: args.include_disabled,
        workspaceRoot: ctx.workspace.active(),
      });
      const entries = skills.map((s) => {
        if (s.hides && s.hides.length > 0) {
          return `${s.name} (${s.source}; hides ${s.hides.join(", ")})`;
        }
        return `${s.name} (${s.source})`;
      });
      return ok("skills_list", `Available skills: ${entries.join(", ")}`, { skills, entries });
    } catch (err) {
      return fail("skills_list", err);
    }
  },
});

export const skillLoadTool = defineTool({
  name: "skill_load",
  title: "Load Skill",
  description: "Load full skill instructions (SKILL.md) or a referenced file from a skill. Load skills early in a task to follow recommended patterns.",
  group: "skills",
  risk: "read",
  input: {
    name: z.string().describe("Skill name to load"),
    file: z
      .string()
      .optional()
      .describe("Optional relative path to a supplementary file inside the skill directory"),
    source: z
      .enum(["builtin", "extra", "workspace", "user"])
      .optional()
      .describe("Optional specific source to load from ('builtin', 'extra', 'workspace', 'user') when shadowed"),
  },
  handler: async (args, ctx) => {
    try {
      const active = ctx.workspace.active();

      if (args.file) {
        const content = await ctx.skills.readFile(args.name, args.file, active, args.source);
        return ok("skill_load", `Loaded ${args.name}/${args.file} (${content.length} chars)`, {
          name: args.name,
          file: args.file,
          content,
        });
      }

      const skill = await ctx.skills.get(args.name, active, args.source);
      if (!skill) {
        return fail("skill_load", `Skill "${args.name}"${args.source ? ` (source: ${args.source})` : ""} not found`);
      }

      let body = skill.body;
      let note: string | undefined;

      if (!args.source && skill.hides && skill.hides.length > 0) {
        const hidden = skill.hides.join(", ");
        note = `Note: A ${hidden} copy of this skill is shadowed. Load it with skill_load({ name: "${skill.name}", source: "${skill.hides[0]}" }).`;
        body = `${body}\n\n${note}`;
      }

      const summary = `Loaded skill "${skill.name}": ${skill.description}${note ? ` (${note})` : ""}`;

      return ok("skill_load", summary, {
        skill: {
          name: skill.name,
          description: skill.description,
          source: skill.source,
          dir: skill.dir,
          files: skill.files,
          enabled: skill.enabled,
          editable: skill.editable,
          body,
          ...(skill.hides ? { hides: skill.hides } : {}),
        },
        ...(note ? { note } : {}),
      });
    } catch (err) {
      return fail("skill_load", err);
    }
  },
});

export const skillSaveTool = defineTool({
  name: "skill_save",
  title: "Save Skill",
  description: "Save a new or updated user skill with instructions and optional supplementary files. Use to persist reusable workflows and domain knowledge.",
  group: "skills",
  risk: "write",
  input: {
    name: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
      .describe("Skill name: lowercase letters, digits, and hyphens (1-64 chars)"),
    description: z.string().describe("Short description telling when the AI client should use this skill"),
    body: z.string().describe("Markdown instructions/guidelines without frontmatter"),
    files: z.record(z.string(), z.string()).optional().describe("Optional extra files: relative path to utf-8 content map"),
  },
  handler: async (args, ctx) => {
    try {
      const summary = await ctx.skills.save({
        name: args.name,
        description: args.description,
        body: args.body,
        files: args.files,
      });

      return ok("skill_save", `Saved user skill "${args.name}"`, { skill: summary });
    } catch (err) {
      return fail("skill_save", err);
    }
  },
});

const tools: ToolModule = [skillsListTool, skillLoadTool, skillSaveTool];
export default tools;
