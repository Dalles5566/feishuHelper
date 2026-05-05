# Skills Learned

> Personal learning log — skills and knowledge gained while building this project.

---

## 2026-05-05

### GitHub CLI (`gh`)
- Installed via `brew install gh`
- Authenticated via browser-based OAuth (`gh auth login`)
- Created repo and pushed in one command: `gh repo create --public --source=. --push`
- `gh` is independent from git config — doesn't affect other workspaces

### Kiro Steering Files
- `.kiro/steering/*.md` files are automatically loaded as rules for AI interactions
- Useful for enforcing team conventions (code style, commit format, etc.)
- Can be always-included or conditionally triggered

### Spec-Driven Development
- Structured approach: Requirements → Design → Tasks
- Requirements use EARS pattern (Event-driven, State-driven, Unwanted event, Ubiquitous)
- Design includes correctness properties for property-based testing
- State machines help model complex workflow lifecycles
