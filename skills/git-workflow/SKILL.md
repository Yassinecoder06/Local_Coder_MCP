---
name: git-workflow
description: "Best practices for git version control: atomic commits, conventional commit syntax, branch management, safe conflict resolution, and staging hygiene."
---

# Git Workflow Best Practices

Standardized version control conventions for solo developers and multi-agent teams.

## 1. Commit Structure & Conventional Commits

Every commit should represent a single logical change. Follow the Conventional Commits specification:

```
<type>(<scope>): <short description in imperative present tense>

[optional body explaining WHY the change was made]

[optional footer(s), e.g. BREAKING CHANGE or issue references]
```

### Common Types:
- `feat`: A new user-facing or API feature.
- `fix`: A bug fix.
- `docs`: Documentation changes only.
- `style`: Changes that do not affect code logic (formatting, semicolons).
- `refactor`: Code change that neither fixes a bug nor adds a feature.
- `perf`: Performance improvement.
- `test`: Adding missing tests or correcting existing tests.
- `chore`: Build process, package updates, or tooling configuration.

### Examples:
- `feat(tools): add multi-file patch support in apply_patch`
- `fix(search): handle missing ripgrep gracefully with JS fallback`
- `test(skills): add path traversal rejection test`

## 2. Commit Hygiene Rules

1. **Atomic Commits**: Group related changes together. Don't bundle unrelated refactoring with a bug fix.
2. **Never Commit Secrets**: Check `git status` and `git diff --staged` before committing. Never commit `.env`, private keys, or passwords.
3. **No Unwanted Attribution**: Do not add AI generation attribution or trailers unless explicitly requested by the user.
4. **Clean Working Tree**: Ensure `git status` is clean before switching branches or pulling upstream.

## 3. Workflow with Local Coder MCP Tools

- **Check Current Status**: Use `git` tool with `subcommand: "status"` to inspect changed files.
- **Inspect Diff**: Use `git` tool with `subcommand: "diff"` to verify exact hunks before staging.
- **Stage Changes**: Use `git_write` tool with `subcommand: "add"`, `args: ["path/to/file"]` (prefer specific files over bare `.`).
- **Commit**: Use `git_write` tool with `subcommand: "commit"`, `args: ["-m", "feat: message"]`.
- **Branch Management**: Use `git_write` tool with `subcommand: "checkout"` or `subcommand: "switch"`.
