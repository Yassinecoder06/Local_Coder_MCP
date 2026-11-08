---
name: skill-authoring
description: "How to write, organize, and save reusable skills in Local Coder MCP using frontmatter conventions and the skill_save tool."
---

# Skill Authoring Guide

Skills extend the agent's capabilities with specialized knowledge, procedural checklists, and reusable templates.

## 1. Skill Folder Structure

A skill is a self-contained directory with `SKILL.md` at its root:

```
<skill-name>/
├── SKILL.md                 # Required: frontmatter + core guidelines
├── references/              # Optional: API docs, specs, schemas
│   └── api-spec.json
└── templates/               # Optional: starter code or configs
    └── config.example.yaml
```

## 2. SKILL.md Frontmatter Specification

Every `SKILL.md` must start with YAML frontmatter:

```markdown
---
name: my-skill-name
description: "Crisp 1-2 sentence description telling the model WHEN and WHY to activate this skill."
---

# My Skill Title

Markdown body containing guidelines, examples, and rules.
```

### Frontmatter Rules:
- `name`: Must match `^[a-z0-9][a-z0-9-]{0,63}$` (lowercase letters, digits, and hyphens; up to 64 chars).
- `description`: Written for the agent model, not the end user. Explicitly state the trigger conditions (e.g. "Use when...").

## 3. Skill Sources & Loading Priority

Skills are resolved in priority order (earlier sources shadow later ones):
1. **User Skills** (`DATA_DIR/skills/`): Created via UI or `skill_save`. Editable.
2. **Workspace Skills** (`<active>/.claude/skills/` and `<active>/.agents/skills/`): Project-specific skills checked into git.
3. **Extra Skills** (`EXTRA_SKILLS_DIRS`): Mounted directories (e.g. host shared libraries).
4. **Built-in Skills** (`skills/`): Shipped with the server.

## 4. Saving Skills via `skill_save`

You can programmatically author or update user skills using the `skill_save` tool:

```json
{
  "name": "docker-debug",
  "description": "Troubleshoot failed Docker builds, container crashes, and networking issues.",
  "body": "# Docker Debugging\n\n1. Check logs: docker logs <id>\n2. Inspect exit code...",
  "files": {
    "templates/compose.debug.yaml": "services:\n  app:\n    image: node:22-alpine\n"
  }
}
```

The server automatically writes the correct frontmatter, validates names, and prevents path traversal.
