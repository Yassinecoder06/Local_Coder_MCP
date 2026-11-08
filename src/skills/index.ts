import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../config.js";
import type { Skill, SkillInput, SkillRegistry, SkillSource, SkillSummary } from "./registry.js";

const NAME_REGEX = /^[a-z0-9][a-z0-9-]{0,63}$/;

function cleanYamlValue(val: string): string {
  const trimmed = val.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\'/g, "'");
  }
  return trimmed;
}

export function parseSkillFrontmatter(raw: string): { name?: string; description?: string; body: string } {
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---")) {
    return { body: normalized };
  }

  const endIdx = normalized.indexOf("\n---", 3);
  if (endIdx === -1) {
    return { body: normalized };
  }

  const fmText = normalized.slice(3, endIdx).trim();
  const body = normalized.slice(endIdx + 4).replace(/^\n+/, "");

  let name: string | undefined;
  let description: string | undefined;

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
      let descVal = descMatch[1].trim();
      const isBlockScalar = descVal === ">" || descVal === "|" || descVal === ">-" || descVal === "|-";
      if (isBlockScalar || descVal === "") {
        // Collect following indented lines
        const blockLines: string[] = [];
        i++;
        while (i < lines.length && (lines[i].startsWith(" ") || lines[i].startsWith("\t") || lines[i].trim() === "")) {
          blockLines.push(lines[i].trim());
          i++;
        }
        i--; // step back for loop increment
        description = blockLines.join(isBlockScalar && descVal.startsWith("|") ? "\n" : " ").trim();
      } else {
        // Check if quoted string spans multiple lines
        if (
          (descVal.startsWith('"') && !descVal.endsWith('"')) ||
          (descVal.startsWith("'") && !descVal.endsWith("'"))
        ) {
          const quoteChar = descVal[0];
          const parts = [descVal.slice(1)];
          i++;
          while (i < lines.length) {
            const nextLine = lines[i].trim();
            if (nextLine.endsWith(quoteChar)) {
              parts.push(nextLine.slice(0, -1));
              break;
            } else {
              parts.push(nextLine);
            }
            i++;
          }
          description = parts.join(" ");
        } else {
          description = cleanYamlValue(descVal);
        }
      }
    }
  }

  return { name, description, body };
}

async function collectFiles(dir: string, baseDir = dir): Promise<string[]> {
  const files: string[] = [];
  let dirents;
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const dirent of dirents) {
    if (dirent.name.startsWith(".") && dirent.name !== ".") continue;
    const fullPath = path.join(dir, dirent.name);
    if (dirent.isDirectory()) {
      const sub = await collectFiles(fullPath, baseDir);
      files.push(...sub);
    } else if (dirent.isFile()) {
      files.push(path.relative(baseDir, fullPath));
    }
  }

  // Ensure SKILL.md is first, sort the rest
  files.sort((a, b) => {
    if (a === "SKILL.md") return -1;
    if (b === "SKILL.md") return 1;
    return a.localeCompare(b);
  });

  return files;
}

export function createSkillRegistry(
  config: AppConfig,
  settings: { get(): { disabledSkills: string[] }; update(p: any): Promise<unknown> }
): SkillRegistry {
  // Directory mtime cache: dirPath -> { mtimeMs: number, skills: Map<string, Skill> }
  const dirCache = new Map<string, { mtimeMs: number; skills: Map<string, Skill> }>();

  async function scanSourceDir(
    sourceDir: string,
    source: SkillSource
  ): Promise<Map<string, Skill>> {
    const skillsMap = new Map<string, Skill>();
    let stat;
    try {
      stat = await fs.stat(sourceDir);
      if (!stat.isDirectory()) return skillsMap;
    } catch {
      return skillsMap;
    }

    const cached = dirCache.get(sourceDir);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      return cached.skills;
    }

    let dirents;
    try {
      dirents = await fs.readdir(sourceDir, { withFileTypes: true });
    } catch {
      return skillsMap;
    }

    for (const dirent of dirents) {
      if (!dirent.isDirectory() || dirent.name.startsWith(".")) continue;

      const skillFolder = path.join(sourceDir, dirent.name);
      const skillMdPath = path.join(skillFolder, "SKILL.md");

      let rawMd: string;
      try {
        rawMd = await fs.readFile(skillMdPath, "utf-8");
      } catch {
        continue; // No SKILL.md
      }

      const parsed = parseSkillFrontmatter(rawMd);
      const name = parsed.name || dirent.name;

      if (!NAME_REGEX.test(name)) continue;

      const files = await collectFiles(skillFolder);

      const skill: Skill = {
        name,
        description: parsed.description || "",
        source,
        dir: skillFolder,
        files,
        enabled: true, // will be resolved with settings
        editable: source === "user",
        body: parsed.body,
      };

      skillsMap.set(name, skill);
    }

    dirCache.set(sourceDir, { mtimeMs: stat.mtimeMs, skills: skillsMap });
    return skillsMap;
  }

  async function loadAllSkills(workspaceRoot?: string): Promise<Map<string, Skill>> {
    const activeWs = workspaceRoot ? path.resolve(workspaceRoot) : config.defaultWorkspace;
    const disabled = new Set(settings.get().disabledSkills ?? []);
    const merged = new Map<string, Skill>();

    // Priority order: user -> workspace -> extra -> builtin
    const sources: Array<{ dir: string; source: SkillSource }> = [];

    // 1. user
    sources.push({ dir: config.userSkillsDir, source: "user" });

    // 2. workspace
    if (activeWs) {
      sources.push({ dir: path.join(activeWs, ".claude", "skills"), source: "workspace" });
      sources.push({ dir: path.join(activeWs, ".agents", "skills"), source: "workspace" });
    }

    // 3. extra
    for (const extraDir of config.extraSkillsDirs) {
      sources.push({ dir: extraDir, source: "extra" });
    }

    // 4. builtin
    sources.push({ dir: config.builtinSkillsDir, source: "builtin" });

    for (const { dir, source } of sources) {
      const map = await scanSourceDir(dir, source);
      for (const [name, skill] of map.entries()) {
        // Earlier source wins: never overwrite
        if (!merged.has(name)) {
          merged.set(name, {
            ...skill,
            enabled: !disabled.has(name),
          });
        }
      }
    }

    return merged;
  }

  return {
    async list(opts?: { includeDisabled?: boolean; workspaceRoot?: string }): Promise<SkillSummary[]> {
      const skillsMap = await loadAllSkills(opts?.workspaceRoot);
      const list: SkillSummary[] = [];

      for (const skill of skillsMap.values()) {
        if (!opts?.includeDisabled && !skill.enabled) {
          continue;
        }
        list.push({
          name: skill.name,
          description: skill.description,
          source: skill.source,
          dir: skill.dir,
          files: skill.files,
          enabled: skill.enabled,
          editable: skill.editable,
        });
      }

      return list.sort((a, b) => a.name.localeCompare(b.name));
    },

    async get(name: string, workspaceRoot?: string): Promise<Skill | undefined> {
      const skillsMap = await loadAllSkills(workspaceRoot);
      return skillsMap.get(name);
    },

    async readFile(name: string, relPath: string, workspaceRoot?: string): Promise<string> {
      const skillsMap = await loadAllSkills(workspaceRoot);
      const skill = skillsMap.get(name);
      if (!skill) {
        throw new Error(`Skill "${name}" not found`);
      }

      const targetPath = path.resolve(skill.dir, relPath);
      if (targetPath !== skill.dir && !targetPath.startsWith(skill.dir + path.sep)) {
        throw new Error("Path traversal outside skill directory is not allowed");
      }

      return await fs.readFile(targetPath, "utf-8");
    },

    async save(input: SkillInput): Promise<SkillSummary> {
      if (!NAME_REGEX.test(input.name)) {
        throw new Error(`Invalid skill name "${input.name}". Must match ^[a-z0-9][a-z0-9-]{0,63}$`);
      }

      const userDir = path.resolve(config.userSkillsDir);
      const targetDir = path.resolve(userDir, input.name);

      if (!targetDir.startsWith(userDir + path.sep) && targetDir !== userDir) {
        throw new Error("Path traversal outside user skills directory is not allowed");
      }

      await fs.mkdir(targetDir, { recursive: true });

      const frontmatter = [
        "---",
        `name: ${input.name}`,
        `description: ${JSON.stringify(input.description)}`,
        "---",
        "",
        input.body.trim(),
        "",
      ].join("\n");

      await fs.writeFile(path.join(targetDir, "SKILL.md"), frontmatter, "utf-8");

      if (input.files) {
        for (const [relFile, content] of Object.entries(input.files)) {
          const filePath = path.resolve(targetDir, relFile);
          if (!filePath.startsWith(targetDir + path.sep)) {
            throw new Error(`Path traversal rejected for skill file "${relFile}"`);
          }
          await fs.mkdir(path.dirname(filePath), { recursive: true });
          await fs.writeFile(filePath, content, "utf-8");
        }
      }

      // Invalidate cache
      dirCache.delete(config.userSkillsDir);

      const files = await collectFiles(targetDir);
      const disabled = new Set(settings.get().disabledSkills ?? []);

      return {
        name: input.name,
        description: input.description,
        source: "user",
        dir: targetDir,
        files,
        enabled: !disabled.has(input.name),
        editable: true,
      };
    },

    async importMarkdown(markdown: string, files?: Record<string, string>): Promise<SkillSummary> {
      const parsed = parseSkillFrontmatter(markdown);
      if (!parsed.name) {
        throw new Error("Skill markdown missing 'name' in frontmatter");
      }
      return this.save({
        name: parsed.name,
        description: parsed.description || "",
        body: parsed.body,
        files,
      });
    },

    async importFromPath(dir: string): Promise<SkillSummary> {
      const absDir = path.resolve(dir);
      const skillMdPath = path.join(absDir, "SKILL.md");

      let raw: string;
      try {
        raw = await fs.readFile(skillMdPath, "utf-8");
      } catch {
        throw new Error(`No SKILL.md found in ${dir}`);
      }

      const parsed = parseSkillFrontmatter(raw);
      const name = parsed.name || path.basename(absDir);

      const allFiles = await collectFiles(absDir);
      const extraFiles: Record<string, string> = {};

      for (const rel of allFiles) {
        if (rel === "SKILL.md") continue;
        const content = await fs.readFile(path.join(absDir, rel), "utf-8");
        extraFiles[rel] = content;
      }

      return this.save({
        name,
        description: parsed.description || "",
        body: parsed.body,
        files: extraFiles,
      });
    },

    async remove(name: string): Promise<void> {
      const userDir = path.resolve(config.userSkillsDir);
      const targetDir = path.resolve(userDir, name);

      let stat;
      try {
        stat = await fs.stat(targetDir);
      } catch {
        throw new Error(`Skill "${name}" not found in user skills directory`);
      }

      if (!stat.isDirectory()) {
        throw new Error(`Skill "${name}" is not a directory`);
      }

      await fs.rm(targetDir, { recursive: true, force: true });
      dirCache.delete(config.userSkillsDir);
    },

    async setEnabled(name: string, enabled: boolean): Promise<void> {
      const disabled = new Set(settings.get().disabledSkills ?? []);
      if (enabled) {
        disabled.delete(name);
      } else {
        disabled.add(name);
      }
      await settings.update({ disabledSkills: Array.from(disabled) });
    },
  };
}
