/**
 * CONTRACT (interface) owned by orchestrator; implementation owned by agy2 (tools).
 *
 * A skill is a folder containing SKILL.md with YAML frontmatter:
 *   ---
 *   name: herdr
 *   description: one line telling the model WHEN to use it
 *   ---
 *   markdown body…
 * plus optional extra files (references, scripts, templates).
 *
 * Sources, in priority order (a later source never overrides an earlier name):
 *   user      — USER_SKILLS_DIR (writable; created by UI / skill_create)
 *   workspace — <active workspace>/.claude/skills and <active>/.agents/skills
 *   extra     — EXTRA_SKILLS_DIRS (e.g. host ~/.agents/skills mounted read-only)
 *   builtin   — BUILTIN_SKILLS_DIR (shipped in repo)
 * Disabled skill names are persisted in DATA_DIR/settings.json (see core/settings.ts).
 */
export type SkillSource = "user" | "workspace" | "extra" | "builtin";

export interface SkillSummary {
  name: string;
  description: string;
  source: SkillSource;
  dir: string; // absolute folder
  files: string[]; // relative paths inside dir, SKILL.md first
  enabled: boolean;
  editable: boolean; // true only for source=user
  hides?: SkillSource[];
}

export interface Skill extends SkillSummary {
  body: string; // full SKILL.md text
}

export interface SkillInput {
  name: string; // [a-z0-9][a-z0-9-]{0,63}
  description: string;
  body: string; // markdown WITHOUT frontmatter (frontmatter is generated)
  files?: Record<string, string>; // extra files: relative path -> utf8 content
}

export interface SkillRegistry {
  list(opts?: { includeDisabled?: boolean; workspaceRoot?: string }): Promise<SkillSummary[]>;
  get(name: string, workspaceRoot?: string, source?: SkillSource): Promise<Skill | undefined>;
  readFile(name: string, relPath: string, workspaceRoot?: string, source?: SkillSource): Promise<string>;
  /** Create or overwrite a user skill. */
  save(input: SkillInput): Promise<SkillSummary>;
  /** Import from a raw SKILL.md text (frontmatter included), e.g. paste/upload in UI. */
  importMarkdown(markdown: string, files?: Record<string, string>): Promise<SkillSummary>;
  /** Copy a skill folder from an absolute path visible to the server into the user dir. */
  importFromPath(dir: string): Promise<SkillSummary>;
  remove(name: string): Promise<void>; // user skills only
  setEnabled(name: string, enabled: boolean): Promise<void>;
}
