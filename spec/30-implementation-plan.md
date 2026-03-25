# Spec 30 — Coding Companion Implementation Plan

> Status: **Draft** | Owner: — | Last updated: 2026-03-25

## 1. Vision

Transform AgentCore from a chat assistant into a persistent, chat-accessible coding companion that can:
- Read, write, and refactor code
- Run tests, builds, and shell commands
- Clone repos and create PRs via GitHub
- Orchestrate sub-agents (Claude Code, Codex) for complex tasks
- Run 24/7 as a daemon, reachable via Telegram from any device
- Support specialized agent personas (code reviewer, backend dev, etc.)

## 2. Phasing Strategy

The work is organized into four phases. Each phase delivers a usable increment and enables the next.

```
Phase 0: Foundation ───────────────────────────────────┐
  Sandbox, Audit Logger, Config extensions              │
                                                        v
Phase 1: Core Coding ─────────────────────────────────┐
  File tools, Shell tools, Approval workflow,          │
  GitHub skill                                         │
                                                       v
Phase 2: Operations ──────────────────────────────────┐
  Daemon mode, Health endpoint, Terminal sessions,     │
  Enhanced scheduler                                   │
                                                       v
Phase 3: Platform ────────────────────────────────────
  CLI, Skill marketplace, Agent delegation,
  Multi-agent profiles, Dashboard
```

## 3. Phase 0 — Foundation

**Goal:** Security infrastructure that every subsequent capability depends on.

**Spec:** [16 — Sandbox & Audit](16-sandbox-and-audit.md)

### Deliverables

| # | Task | New/Modified files | Tests |
|---|------|--------------------|-------|
| 0.1 | Workspace Sandbox class | `src/security/sandbox.js` | `test/sandbox.test.js` |
| 0.2 | Audit Logger + migration | `src/security/audit-logger.js`, `src/db/migrations/003-audit-log.js` | `test/audit-logger.test.js` |
| 0.3 | Config extensions | `src/config.js` (add `workspaceDir`, `auditLogEnabled`) | Existing config tests |
| 0.4 | Audit hook in ToolExecutor | `src/tools/tool-executor.js` (modify) | `test/tool-executor.test.js` (extend) |
| 0.5 | Wire sandbox + audit in index.js | `src/index.js` (Phase 4b) | Integration test |

### Acceptance criteria

- [ ] `sandbox.resolve('../../../etc/passwd')` throws `SandboxViolationError`
- [ ] Symlink escapes are blocked
- [ ] Every tool execution (success and failure) appears in `audit_log` table
- [ ] Audit entries are truncated to 2KB (no DB bloat)
- [ ] All existing tests still pass

---

## 4. Phase 1 — Core Coding Capability

**Goal:** The agent can read code, write files, run tests, and interact with git.

**Specs:** [17 — Workspace Tools](17-workspace-tools.md), [18 — Shell Execution](18-shell-execution.md), [19 — Approval Workflow](19-approval-workflow.md)

### Deliverables

| # | Task | New/Modified files | Spec |
|---|------|--------------------|------|
| 1.1 | File system tools (6 tools) | `src/tools/built-in/fs-tools.js` | 17 |
| 1.2 | Tool policy updates (fs:read, fs:write scopes) | `src/security/tool-policy.js` (modify) | 17 |
| 1.3 | Process Manager | `src/process/process-manager.js` | 18 |
| 1.4 | Shell tools (5 tools) | `src/tools/built-in/shell-tools.js` | 18 |
| 1.5 | Tool policy updates (shell:execute scope) | `src/security/tool-policy.js` (modify) | 18 |
| 1.6 | Approval Manager | `src/security/approval-manager.js` | 19 |
| 1.7 | Approval hook in ToolExecutor | `src/tools/tool-executor.js` (modify) | 19 |
| 1.8 | /approve and /reject commands | `src/core/command-router.js` (modify) | 19 |
| 1.9 | GitHub skill | `skills/github/SKILL.md` | — |
| 1.10 | Wire everything in index.js | `src/index.js` (modify) | — |
| 1.11 | Tests | `test/fs-tools.test.js`, `test/shell-tools.test.js`, `test/approval.test.js`, `test/process-manager.test.js` | — |

### Implementation order

```
1.1 + 1.2 (file tools)  ──parallel──  1.3 (process manager)
          │                                    │
          v                                    v
       [test]                          1.4 + 1.5 (shell tools)
                                               │
                                               v
                                           [test]
                                               │
                                               v
                               1.6 + 1.7 + 1.8 (approval workflow)
                                               │
                                               v
                                  1.9 (GitHub skill)
                                               │
                                               v
                                      1.10 (wiring)
                                               │
                                               v
                                    1.11 (integration tests)
```

### Acceptance criteria

- [ ] Agent can read files: `"Read src/index.js"` → returns file content with line numbers
- [ ] Agent can edit files: `"Add a comment to line 10 of index.js"` → edits file correctly
- [ ] Agent can run commands: `"Run npm test"` → executes, returns output
- [ ] Non-admin user gets approval prompt before shell execution
- [ ] `/approve` and `/reject` work across Console and Telegram adapters
- [ ] Agent can clone a repo and run git commands when given a GitHub token
- [ ] Background processes can be started, monitored, and killed
- [ ] All operations stay within `WORKSPACE_DIR` (sandbox enforced)
- [ ] All tool executions are audit-logged

### E2E verification scenario

```
User (Telegram): "Clone https://github.com/example/repo into workspace,
                   read the README, run npm test, and tell me the results"

Expected agent behavior:
1. run_command: git clone https://github.com/example/repo workspace/repo
2. read_file: workspace/repo/README.md
3. run_command: cd workspace/repo && npm install
4. run_command: cd workspace/repo && npm test
5. Summarize test results to user
```

---

## 5. Phase 2 — Operational Maturity

**Goal:** The agent runs 24/7 reliably and can manage long-running processes.

**Spec:** [20 — Daemon & Health](20-daemon-and-health.md)

### Deliverables

| # | Task | New/Modified files |
|---|------|--------------------|
| 2.1 | PM2 ecosystem config | `ecosystem.config.cjs` |
| 2.2 | Docker setup | `Dockerfile`, `docker-compose.yml`, `.dockerignore` |
| 2.3 | Health endpoint server | `src/web/health.js` |
| 2.4 | Wire health server in index.js | `src/index.js` (modify) |
| 2.5 | Config extensions (HEALTH_PORT) | `src/config.js` (modify) |
| 2.6 | Terminal session manager (optional) | `src/process/terminal-session-manager.js` |
| 2.7 | Enhanced task scheduler | `src/scheduler/scheduler.js` |
| 2.8 | Tests | `test/health.test.js`, `test/scheduler.test.js` |

### Acceptance criteria

- [ ] `pm2 start ecosystem.config.cjs` starts the agent; `pm2 startup` enables boot persistence
- [ ] `docker-compose up -d` starts the agent in a container with persistent data
- [ ] `GET /health` returns 200 with agent status
- [ ] `GET /status` (with auth) returns extended info
- [ ] Health endpoint correctly reports degraded state when an adapter is down
- [ ] Tasks in `tasks/` directory execute independently on their schedules
- [ ] Agent reconnects to existing tmux sessions after restart (if terminal sessions implemented)

---

## 6. Phase 3 — Platform Features

**Goal:** Developer experience polish and advanced capabilities.

**Specs:** [21 — Agent Delegation](21-agent-delegation.md), [22 — CLI & Platform](22-cli-and-platform.md)

### Deliverables

| # | Task | New/Modified files |
|---|------|--------------------|
| 3.1 | CLI entry point + subcommands | `bin/agentcore.js` |
| 3.2 | Onboarding wizard | `src/cli/onboard-wizard.js` |
| 3.3 | Skill installer | `src/skills/skill-installer.js` |
| 3.4 | Skill manifest | `data/skills-manifest.json` |
| 3.5 | Delegation manager | `src/core/delegation-manager.js` |
| 3.6 | Delegation backends | `src/core/delegation-backends.js` |
| 3.7 | Delegation tools | `src/tools/built-in/delegation-tools.js` |
| 3.8 | Agent profile system | `src/agents/agent-profile.js`, `src/agents/agent-registry.js` |
| 3.9 | HostDispatcher + PromptBuilder changes | `src/core/host-dispatcher.js`, `src/brain/prompt-builder.js` (modify) |
| 3.10 | Memory namespace support | `src/memory/persistent-memory.js`, `src/memory/memory-search.js` (modify) |
| 3.11 | /agent command | `src/core/command-router.js` (modify) |
| 3.12 | Dashboard REST API | `src/web/server.js` |
| 3.13 | Dashboard frontend | `src/web/public/` |
| 3.14 | Tests | Various |

### Acceptance criteria

- [ ] `agentcore onboard` walks through setup and creates `.env`
- [ ] `agentcore skill install <url>` downloads and registers a skill
- [ ] Agent can delegate tasks to Claude Code CLI and report results
- [ ] `/agent code-reviewer` switches session to code-reviewer persona
- [ ] Each agent profile has isolated memory
- [ ] Dashboard shows sessions, users, tools, audit log
- [ ] Dashboard requires authentication

---

## 7. File Change Summary

### New files (by phase)

**Phase 0** (3 files):
- `src/security/sandbox.js`
- `src/security/audit-logger.js`
- `src/db/migrations/003-audit-log.js`

**Phase 1** (6 files + 1 skill):
- `src/tools/built-in/fs-tools.js`
- `src/tools/built-in/shell-tools.js`
- `src/process/process-manager.js`
- `src/security/approval-manager.js`
- `skills/github/SKILL.md`
- Tests: `test/fs-tools.test.js`, `test/shell-tools.test.js`, `test/approval.test.js`, `test/process-manager.test.js`

**Phase 2** (5 files + config):
- `ecosystem.config.cjs`
- `Dockerfile`, `docker-compose.yml`
- `src/web/health.js`
- `src/scheduler/scheduler.js`
- `src/process/terminal-session-manager.js` (optional)

**Phase 3** (10+ files):
- `bin/agentcore.js`
- `src/cli/onboard-wizard.js`
- `src/skills/skill-installer.js`
- `src/core/delegation-manager.js`
- `src/core/delegation-backends.js`
- `src/tools/built-in/delegation-tools.js`
- `src/agents/agent-profile.js`
- `src/agents/agent-registry.js`
- `src/web/server.js`
- `src/web/public/` (index.html, app.js, style.css)

### Modified files (accumulated across phases)

| File | Changes |
|------|---------|
| `src/config.js` | +~10 env vars (WORKSPACE_DIR, HEALTH_PORT, DASHBOARD_ENABLED, MAX_DELEGATIONS, etc.) |
| `src/security/tool-policy.js` | Add fs:read, fs:write, shell:execute, agent:delegate scopes; update all profiles |
| `src/tools/tool-executor.js` | Add audit hook (Phase 0) + approval hook (Phase 1) |
| `src/index.js` | Add wiring phases for sandbox, audit, process manager, health server, scheduler, delegation, agents |
| `src/core/command-router.js` | Add /approve, /reject (Phase 1), /agent (Phase 3) |
| `src/core/host-dispatcher.js` | Agent profile resolution (Phase 3) |
| `src/brain/prompt-builder.js` | Accept custom soul from agent profile (Phase 3) |
| `src/memory/persistent-memory.js` | Namespace support (Phase 3) |
| `src/memory/memory-search.js` | Namespace support (Phase 3) |
| `package.json` | Add "bin" field (Phase 3), possibly cron-parser dependency |

---

## 8. Dependency Graph

```
                    Phase 0
                 ┌─────────────┐
                 │   Sandbox    │
                 │ Audit Logger │
                 │   Config     │
                 └──────┬──────┘
                        │
            ┌───────────┼───────────┐
            v           v           v
      ┌──────────┐ ┌─────────┐ ┌────────────┐
      │ FS Tools │ │ Shell   │ │  Approval  │
      │ (Spec 17)│ │ Tools   │ │  Workflow  │
      └────┬─────┘ │(Spec 18)│ │ (Spec 19)  │
           │       └────┬────┘ └─────┬──────┘
           │            │            │
           └────────────┼────────────┘
                        │
                   Phase 1 Complete
                        │
            ┌───────────┼───────────┐
            v           v           v
      ┌──────────┐ ┌─────────┐ ┌────────────┐
      │  Daemon  │ │ Health  │ │ Scheduler  │
      │  (PM2/   │ │Endpoint │ │ Enhanced   │
      │  Docker) │ │(Spec 20)│ │ (Spec 20)  │
      └──────────┘ └────┬────┘ └────────────┘
                        │
                   Phase 2 Complete
                        │
         ┌──────────────┼──────────────┐
         v              v              v
   ┌──────────┐  ┌────────────┐  ┌──────────┐
   │   CLI    │  │ Delegation │  │Dashboard │
   │  Skill   │  │ Multi-Agent│  │ REST API │
   │Installer │  │ (Spec 21)  │  │(Spec 22) │
   │(Spec 22) │  └────────────┘  └──────────┘
   └──────────┘
```

## 9. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| Shell commands escape sandbox | Medium | High | Defense-in-depth: sandbox + audit + approval. Run on isolated machine. |
| LLM uses tools incorrectly (wrong files, bad commands) | High | Medium | Approval workflow for destructive ops. Audit log for review. |
| Background processes accumulate (memory leak) | Low | Medium | ProcessManager enforces cap (10). Graceful shutdown kills all. |
| Delegation tasks hang indefinitely | Medium | Low | Timeout enforcement in DelegationManager. |
| Skill injection (malicious SKILL.md) | Low | High | Skills are reviewed before install. Future: signing. |
| Context window pressure from large file reads | Medium | Medium | 50KB output cap on all file tools. Line offset/limit support. |

## 10. What This Enables

After all phases are complete, the agent can handle prompts like:

- *"Clone this repo, study the architecture, and write a summary"*
- *"Refactor the auth module to use JWT and add tests"*
- *"Check why my last PR build failed and suggest a fix"*
- *"Run the test suite every 30 minutes and alert me if anything breaks"*
- *"Delegate the frontend work to Claude Code while I work on the API"*
- *"Switch to the code-reviewer persona and review my last commit"*

All accessible from your phone via Telegram, running 24/7 on a VPS or home server.
