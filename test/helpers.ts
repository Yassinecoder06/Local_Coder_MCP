import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig, type AppConfig } from "../src/config.js";
import { createWorkspace, type Workspace } from "../src/core/workspace.js";
import { createMemoryActivityLog, type ActivityLog } from "../src/core/activity.js";
import { createSkillRegistry } from "../src/skills/index.js";
import { createCommandRegistry } from "../src/commands/index.js";
import { createBoard, type Board } from "../src/core/board.js";
import type { ToolContext } from "../src/core/types.js";

export interface TestEnvironment {
  tempDir: string;
  workspaceDir: string;
  dataDir: string;
  skillsDir: string;
  commandsDir: string;
  config: AppConfig;
  workspace: Workspace;
  activity: ActivityLog;
  board: Board;
  ctx: ToolContext;
  cleanup: () => Promise<void>;
}

export async function createTestEnvironment(overrides?: Partial<AppConfig>): Promise<TestEnvironment> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "local-coder-test-"));
  const workspaceDir = path.join(tempDir, "workspace");
  const dataDir = path.join(tempDir, "data");
  const skillsDir = path.join(tempDir, "skills");
  const commandsDir = path.join(tempDir, "commands");

  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(skillsDir, { recursive: true });
  await fs.mkdir(commandsDir, { recursive: true });

  const envConfig = loadConfig({
    WORKSPACE_ROOTS: workspaceDir,
    DEFAULT_WORKSPACE: workspaceDir,
    DATA_DIR: dataDir,
    BUILTIN_SKILLS_DIR: skillsDir,
    USER_SKILLS_DIR: path.join(dataDir, "skills"),
    BUILTIN_COMMANDS_DIR: commandsDir,
    USER_COMMANDS_DIR: path.join(dataDir, "commands"),
    SHELL_SYNC_MS: "1000",
  });

  const config: AppConfig = {
    ...envConfig,
    ...overrides,
  };

  const workspace = createWorkspace([workspaceDir], workspaceDir);
  const activity = createMemoryActivityLog();

  let disabledSkills: string[] = [];
  const settings = {
    get: () => ({ disabledSkills }),
    update: async (p: any) => {
      if (p.disabledSkills) disabledSkills = p.disabledSkills;
    },
  };

  const skills = createSkillRegistry(config, settings);
  const commands = createCommandRegistry(config);
  const board = createBoard(dataDir);

  const ctx: ToolContext = {
    config,
    workspace,
    skills,
    commands,
    activity,
    board,
  };

  const cleanup = async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  };

  return {
    tempDir,
    workspaceDir,
    dataDir,
    skillsDir,
    commandsDir,
    config,
    workspace,
    activity,
    board,
    ctx,
    cleanup,
  };
}
