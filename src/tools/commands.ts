import { z } from "zod";
import { defineTool, type ToolModule } from "../core/types.js";
import { ok, fail } from "../core/result.js";

export const commandsListTool = defineTool({
  name: "commands_list",
  title: "List Commands",
  description: "List available reusable task commands and recipes. Inspect available commands for standardized workflows like review, test, plan, and ship.",
  group: "commands",
  risk: "read",
  input: {},
  handler: async (_args, ctx) => {
    try {
      const commands = await ctx.commands.list();
      const names = commands.map((c) => c.name).join(", ");
      return ok("commands_list", `Available commands: ${names}`, { commands });
    } catch (err) {
      return fail("commands_list", err);
    }
  },
});

export const commandRunTool = defineTool({
  name: "command_run",
  title: "Run Command",
  description: "Render a task recipe command with arguments into actionable instructions the model must follow. Use to execute standard workflows.",
  group: "commands",
  risk: "read",
  input: {
    name: z.string().describe("Command name to run"),
    args: z
      .record(z.string(), z.string())
      .default({})
      .optional()
      .describe("Key-value arguments to interpolate into the command template"),
  },
  handler: async (args, ctx) => {
    try {
      const command = await ctx.commands.get(args.name);
      if (!command) {
        return fail("command_run", `Command "${args.name}" not found`);
      }

      const instructions = await ctx.commands.render(args.name, args.args ?? {});
      return ok("command_run", `Command "${args.name}" rendered instructions: follow them now.`, {
        command: args.name,
        description: command.description,
        instructions,
      });
    } catch (err) {
      return fail("command_run", err);
    }
  },
});

const tools: ToolModule = [commandsListTool, commandRunTool];
export default tools;
