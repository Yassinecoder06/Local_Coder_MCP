---
name: refactor
description: Refactor code to improve structure, readability, and performance while preserving behavior
args: [target]
---

You are refactoring code: {{target}}

1. Baseline verification:
   - Use `run` to run existing tests and ensure all tests currently pass before modifying anything.
2. Inspect target code:
   - Use `read` to study the implementation and its callers.
   - Identify code smells, excessive complexity, duplication, or performance bottlenecks.
3. Apply refactoring incrementally:
   - Use `edit` or `apply_patch` for clean changes.
   - Keep behavior identical and API contracts intact.
4. Verify refactoring:
   - Run tests using `run` after each step.
   - Verify static typing with `npm run typecheck` or equivalent.
5. Report changes made and advantages gained.
