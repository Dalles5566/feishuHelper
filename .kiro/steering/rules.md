# Development Rules

## Language & Code Style

- **Programming language**: TypeScript (Node.js runtime)
- **Code comments**: English only
- **Variable/function naming**: camelCase
- **Class/interface naming**: PascalCase
- **File naming**: camelCase for source files, kebab-case for config files

## Git Conventions

- **Commit message format**: `MM/DD/YYYY-description of what this commit does`
  - Example: `05/05/2026-init project spec and design documents`
  - Example: `05/06/2026-add webhook gateway implementation`
- **Branch strategy**: Push to new branches, never directly to main
- **Default branch**: main
- **Before every commit**: Update both `docs/worklogCN.md` and `docs/worklogEN.md` with what this commit does, then commit everything together

## Documentation

- **Code comments**: English
- **User-facing docs**: Bilingual (CN + EN versions in `docs/` folder)
- **Work logs**: Updated daily in both `docs/worklogCN.md` and `docs/worklogEN.md`
- **When updating worklog**: Always update BOTH `docs/worklogCN.md` (Chinese) and `docs/worklogEN.md` (English) simultaneously

## Project Structure

- `.kiro/specs/` — Spec files (system use, do not rename)
- `.kiro/steering/` — AI steering rules
- `docs/` — Bilingual design docs and work logs
- `src/` — Source code (TypeScript)

## General Principles

- This project is fully AI-assisted. Note this in documentation where appropriate.
- Rules may evolve over time. Update this file as new conventions are established.

## Task Description Format

When updating a task's description (via `updateTaskDescription`), the LLM should generate content in this format:

```
## 总概括
[One-sentence summary of the task's current goal]

## 要点
- [Key point 1]
- [Key point 2]
- ...

## 变更历史
- [Latest date]: [What was decided/changed in that meeting]
- [Earlier date]: [What was decided/changed in that meeting]
- ...
```

Rules:
- 变更历史 shows the most recent date first (newest on top)
- Each entry references which meeting triggered the change
- 总概括 and 要点 always reflect the latest state (not historical)

## Development Workflow Principles (inspired by Superpowers)

- **Test after every change**: After modifying code, always run relevant tests before presenting the result
- **Systematic debugging**: When something fails, analyze the root cause first (read logs, check state, trace the flow). Don't guess-and-check
- **Verify before completion**: Before marking a task as done, confirm all tests pass and there are no TypeScript errors
- **Design before code**: For non-trivial changes, explain the approach first, then implement
- **Small focused changes**: Break large tasks into small, verifiable steps. Each step should be independently testable
- **Evidence over claims**: Don't say "this should work" — run it and prove it works
