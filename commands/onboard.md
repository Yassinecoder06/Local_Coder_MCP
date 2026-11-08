---
name: onboard
description: Map an unfamiliar repository: inspect structure, stack, build and test commands, and identify key risks
args: [focus]
---

You are onboarding to an unfamiliar codebase. Follow these instructions:

1. Discover workspace environment and stack:
   - Call `workspace_info` to inspect the detected runtime stack, package scripts, git branch, and AGENTS.md / CLAUDE.md instructions.
2. Inspect repository layout:
   - Use `list` with depth 2 or 3 to understand top-level directories and configuration files.
3. Identify build, run, and test commands:
   - Check configuration files (e.g. package.json, Cargo.toml, Makefile, pyproject.toml, compose.yaml) using `read`.
{{#if focus}}
4. Deep-dive into requested focus area: {{focus}}
   - Use `search` to locate core entrypoints and components related to the focus.
{{/if}}
5. Produce a crisp onboarding briefing:
   - **Repository Purpose & Architecture**: High-level overview of what the project does.
   - **Tech Stack & Tooling**: Languages, frameworks, key libraries, and package managers.
   - **Development Workflow**: Exact commands to install dependencies, run dev server, build, and test.
   - **Key Entrypoints & Directories**: Where primary logic, routes, tests, and configuration live.
   - **Potential Risks & Gotchas**: Uncommitted changes, missing env vars, security boundaries, or test quirks.
