// STUB — agy2 replaces
import type { AppConfig } from "../config.js";
import type { Command, CommandRegistry, CommandSummary } from "./registry.js";

export function createCommandRegistry(_config: AppConfig): CommandRegistry {
  return {
    async list(): Promise<CommandSummary[]> {
      return [];
    },
    async get(_name): Promise<Command | undefined> {
      return undefined;
    },
    async render(_name, args): Promise<string> {
      return Object.entries(args)
        .map(([k, v]) => `${k}: ${v}`)
        .join(" ");
    },
    async save(input): Promise<CommandSummary> {
      return {
        name: input.name,
        description: input.description,
        args: input.args ?? [],
        source: "user",
        editable: true,
      };
    },
    async remove(_name): Promise<void> {},
  };
}
