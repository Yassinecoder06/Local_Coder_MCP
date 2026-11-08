/** Owned by agy2. Aggregates every tool module. */
import type { ToolModule } from "../core/types.js";
import workspaceTools from "./workspace.js";
import filesTools from "./files.js";
import searchTools from "./search.js";
import shellTools from "./shell.js";
import gitTools from "./git.js";
import skillsTools from "./skills.js";
import commandsTools from "./commands.js";
import systemTools from "./system.js";
import browserTools from "./browser.js";
import memoryTools from "./memory.js";

export const ESSENTIAL_TOOLS = new Set<string>([
  "workspace_info",
  "workspace_switch",
  "read",
  "list",
  "search",
  "checkpoints",
  "edit_files",
  "run",
  "job",
  "git",
  "git_write",
  "skills_list",
  "skill_load",
  "skill_save",
  "commands_list",
  "command_run",
  "fetch_url",
  "status",
  "todo",
  "resume",
  "browser_check",
]);

const modules: ToolModule[] = [
  workspaceTools,
  filesTools,
  searchTools,
  shellTools,
  gitTools,
  skillsTools,
  commandsTools,
  systemTools,
  memoryTools,
  browserTools,
];

export default modules;
