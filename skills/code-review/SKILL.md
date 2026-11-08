---
name: code-review
description: "Systematic code review guidelines: correctness, security vulnerabilities, edge cases, error handling, performance, test coverage, and constructive feedback."
---

# Code Review Guidelines

A structured, methodical approach to reviewing code changes in any programming language or framework.

## 1. Review Goals & Philosophy

The objective of code review is to ensure correctness, maintainability, reliability, and security while keeping momentum. Focus on:
- High impact: Logic bugs, security vulnerabilities, resource leaks, edge cases, data loss risks.
- Medium impact: Error handling, architecture alignment, readability, test coverage.
- Low impact: Formatting, style preferences (leave to linters and formatters whenever possible).

## 2. Review Checklist

### A. Correctness & Logic
- Does the code actually solve the stated problem or user requirement?
- Are edge conditions handled? (Null/undefined, empty arrays, zero division, boundary values, negative numbers).
- Are concurrent operations safe? (Race conditions, async error propagation, lock starvation).
- Is state mutation intentional and predictable?

### B. Security & Safety
- **Injection Attacks**: Are user inputs parameterized in SQL queries, shell commands, or HTML templates?
- **Authentication & Authorization**: Are access control checks enforced at the handler/service level?
- **Data Exposure**: Are sensitive secrets, tokens, or PII exposed in logs, API responses, or error messages?
- **Resource Exhaustion**: Are inputs validated for size, length, and timeout limits (DoS prevention)?

### C. Error Handling & Resilience
- Are promises and async calls wrapped or properly awaited?
- Are errors caught and translated into informative, user-safe messages?
- Does cleanup run in `finally` blocks (closing files, releasing locks, clearing timers)?
- Do operations support retries or idempotent execution where appropriate?

### D. Testing & Verification
- Are there automated tests verifying both happy paths and error paths?
- Do test assertions verify state changes, not just execution without throwing?
- Are tests deterministic (no flaky timeouts, hardcoded dates, or unmocked external network calls)?

## 3. Review Process with Server Tools

When conducting a code review in Local Coder MCP:
1. **Inspect changes**: Use `git` tool with `subcommand: "diff"` or `subcommand: "status"` to view all touched files.
2. **Read surrounding context**: Use `read` tool to inspect modified functions in their full context.
3. **Run tests**: Use `run` tool to execute `npm test`, `cargo test`, `pytest`, or the project's test command.
4. **Deliver clear feedback**: Categorize comments by severity (`[Critical]`, `[Warning]`, `[Suggestion]`, `[Praise]`).
