// STUB — agy2 replaces
import type { AppConfig } from "../config.js";
import type { Skill, SkillInput, SkillRegistry, SkillSummary } from "./registry.js";

export function createSkillRegistry(_config: AppConfig, _settings?: any): SkillRegistry {
  return {
    async list(_opts): Promise<SkillSummary[]> {
      return [];
    },
    async get(_name, _workspaceRoot): Promise<Skill | undefined> {
      return undefined;
    },
    async readFile(_name, _relPath, _workspaceRoot): Promise<string> {
      throw new Error("Skill not found (stub)");
    },
    async save(input: SkillInput): Promise<SkillSummary> {
      return {
        name: input.name,
        description: input.description,
        source: "user",
        dir: "/tmp",
        files: ["SKILL.md"],
        enabled: true,
        editable: true,
      };
    },
    async importMarkdown(_markdown, _files): Promise<SkillSummary> {
      throw new Error("Skill import not implemented in stub");
    },
    async importFromPath(_dir): Promise<SkillSummary> {
      throw new Error("Skill import not implemented in stub");
    },
    async remove(_name): Promise<void> {},
    async setEnabled(_name, _enabled): Promise<void> {},
  };
}
