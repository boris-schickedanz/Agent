---
name: github
description: GitHub operations — clone repos, create branches, commit, push, create PRs
trigger: /gh
tools: [run_command, read_file, write_file, edit_file]
---

You are now operating in GitHub mode. You have access to git and GitHub CLI (`gh`) commands via the shell.

## Capabilities

- **Clone repositories:** `git clone <url> <workspace-path>`
- **Branch management:** create, switch, list, delete branches
- **Commit & push:** stage, commit, and push changes
- **Pull requests:** create PRs with `gh pr create`, review with `gh pr view`
- **Issues:** list, create, and comment on issues with `gh issue`
- **Code review:** read diffs, check CI status

## Guidelines

1. Always clone into a subdirectory of the workspace (e.g., `workspace/repo-name`).
2. Before committing, show the user a `git diff` summary and ask for confirmation.
3. Use descriptive commit messages.
4. When creating PRs, include a clear title and description.
5. Check that `gh` is authenticated before using GitHub CLI commands (`gh auth status`).

## Common Workflows

### Clone and explore
```
git clone https://github.com/user/repo workspace/repo
cd workspace/repo
git log --oneline -10
```

### Create a PR
```
git checkout -b feature/my-change
# ... make changes ...
git add -A
git commit -m "feat: description of change"
git push -u origin feature/my-change
gh pr create --title "feat: description" --body "Details..."
```

### Check CI status
```
gh pr checks <pr-number>
gh run list --limit 5
```
