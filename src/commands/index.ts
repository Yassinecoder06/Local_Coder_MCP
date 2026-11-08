import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../config.js";
import type { Command, CommandRegistry, CommandSummary } from "./registry.js";

const NAME_REGEX = /^[a-z0-9][a-z0-9-]{0,63}$/;

function cleanYamlValue(val: string): string {
  const trimmed = val.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\'/g, "'");
  }
  return trimmed;
}

function parseCommandArgs(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed
      .slice(1, -1)
      .split(",")
      .map((s) => cleanYamlValue(s))
      .filter(Boolean);
  }
  return trimmed
    .split(",")
    .map((s) => cleanYamlValue(s))
    .filter(Boolean);
}

export function parseCommandFrontmatter(raw: string): {
  name?: string;
  description?: string;
  args: string[];
  template: string;
} {
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---")) {
    return { args: [], template: normalized };
  }

  const endIdx = normalized.indexOf("\n---", 3);
  if (endIdx === -1) {
    return { args: [], template: normalized };
  }

  const fmText = normalized.slice(3, endIdx).trim();
  const template = normalized.slice(endIdx + 4).replace(/^\n+/, "");

  let name: string | undefined;
  let description: string | undefined;
  const argsList: string[] = [];

  const lines = fmText.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const nameMatch = line.match(/^name:\s*(.+)$/);
    if (nameMatch) {
      name = cleanYamlValue(nameMatch[1]);
      continue;
    }

    const descMatch = line.match(/^description:\s*(.*)$/);
    if (descMatch) {
      description = cleanYamlValue(descMatch[1]);
      continue;
    }

    const argsMatch = line.match(/^args:\s*(.*)$/);
    if (argsMatch) {
      const rest = argsMatch[1].trim();
      if (rest) {
        argsList.push(...parseCommandArgs(rest));
      } else {
        // Multi-line list items: - arg1
        i++;
        while (i < lines.length && (lines[i].trim().startsWith("-") || lines[i].startsWith(" "))) {
          const item = lines[i].trim().replace(/^-\s*/, "");
          if (item) argsList.push(cleanYamlValue(item));
          i++;
        }
        i--;
      }
    }
  }

  return { name, description, args: argsList, template };
}

export function createCommandRegistry(config: AppConfig): CommandRegistry {
  async function scanDir(
    dir: string,
    source: "user" | "builtin"
  ): Promise<Map<string, Command>> {
    const map = new Map<string, Command>();
    let dirents;
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return map;
    }

    for (const dirent of dirents) {
      if (!dirent.isFile() || !dirent.name.endsWith(".md")) continue;

      const filePath = path.join(dir, dirent.name);
      let content: string;
      try {
        content = await fs.readFile(filePath, "utf-8");
      } catch {
        continue;
      }

      const parsed = parseCommandFrontmatter(content);
      const name = parsed.name || path.basename(dirent.name, ".md");

      if (!NAME_REGEX.test(name)) continue;

      map.set(name, {
        name,
        description: parsed.description || "",
        args: parsed.args,
        source,
        editable: source === "user",
        template: parsed.template,
      });
    }

    return map;
  }

  async function loadAllCommands(): Promise<Map<string, Command>> {
    const merged = new Map<string, Command>();

    // 1. user commands
    const userCommands = await scanDir(config.userCommandsDir, "user");
    for (const [name, cmd] of userCommands) {
      merged.set(name, cmd);
    }

    // 2. builtin commands
    const builtinCommands = await scanDir(config.builtinCommandsDir, "builtin");
    for (const [name, cmd] of builtinCommands) {
      if (!merged.has(name)) {
        merged.set(name, cmd);
      }
    }

    return merged;
  }

  return {
    async list(): Promise<CommandSummary[]> {
      const all = await loadAllCommands();
      const list: CommandSummary[] = [];

      for (const cmd of all.values()) {
        list.push({
          name: cmd.name,
          description: cmd.description,
          args: cmd.args,
          source: cmd.source,
          editable: cmd.editable,
        });
      }

      return list.sort((a, b) => a.name.localeCompare(b.name));
    },

    async get(name: string): Promise<Command | undefined> {
      const all = await loadAllCommands();
      return all.get(name);
    },

    async render(name: string, args: Record<string, string>): Promise<string> {
      const all = await loadAllCommands();
      const cmd = all.get(name);
      if (!cmd) {
        throw new Error(`Command "${name}" not found`);
      }

      let rendered = cmd.template;

      // Replace specific {{key}}
      for (const [key, value] of Object.entries(args)) {
        const regex = new RegExp(`\\{\\{${key}\\}\\}`, "g");
        rendered = rendered.replace(regex, value);
      }

      // Replace {{args}} with all args joined
      const joinedArgs = args.args || Object.values(args).filter(Boolean).join(" ");
      rendered = rendered.replace(/\{\{args\}\}/g, joinedArgs);

      // Replace any remaining {{...}} with empty string
      rendered = rendered.replace(/\{\{[a-zA-Z0-9_-]+\}\}/g, "");

      return rendered.trim();
    },

    async save(input: {
      name: string;
      description: string;
      args?: string[];
      template: string;
    }): Promise<CommandSummary> {
      if (!NAME_REGEX.test(input.name)) {
        throw new Error(`Invalid command name "${input.name}". Must match ^[a-z0-9][a-z0-9-]{0,63}$`);
      }

      const userDir = path.resolve(config.userCommandsDir);
      await fs.mkdir(userDir, { recursive: true });

      const targetFile = path.join(userDir, `${input.name}.md`);
      const argsList = input.args ?? [];
      const frontmatter = [
        "---",
        `name: ${input.name}`,
        `description: ${JSON.stringify(input.description)}`,
        `args: [${argsList.map((a) => JSON.stringify(a)).join(", ")}]`,
        "---",
        "",
        input.template.trim(),
        "",
      ].join("\n");

      await fs.writeFile(targetFile, frontmatter, "utf-8");

      return {
        name: input.name,
        description: input.description,
        args: argsList,
        source: "user",
        editable: true,
      };
    },

    async remove(name: string): Promise<void> {
      const userDir = path.resolve(config.userCommandsDir);
      const targetFile = path.join(userDir, `${name}.md`);

      try {
        await fs.unlink(targetFile);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error(`Command "${name}" is not a user command or does not exist`);
        }
        throw err;
      }
    },
  };
}
