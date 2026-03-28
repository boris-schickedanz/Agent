# Use Cases & Product Requirements (PRD)

> Status: **Active** | Owner: — | Last updated: 2026-03-28

This document is the canonical inventory of everything a user can do with AgentCore. It describes flows from the user's perspective, maps each to the components involved, and tracks end-to-end test coverage. Technical specs describe *how* subsystems work; this PRD describes *what the user experiences*.

## 1. System Model

AgentCore is a **single-user, single continuous session** system. One user interacts via one or more adapters (console, Telegram). All adapters share a single conversation history and project context. There are no group chats and no multi-user access control.

The user has access to all tools, with an approval workflow gating destructive operations (write, shell) for safety.

Legacy multi-user infrastructure (roles, per-user rate limiting, `user_aliases` table) has been removed from active code paths per [Spec 32](32-single-user-migration.md). Database tables remain in place (no destructive migrations) but are no longer referenced.

---

## 2. Use Cases

Each use case lists: trigger, expected behavior, key components, and E2E test status.

### 2.1 Chat & Conversation Management

| # | Use Case | Trigger | Expected Behavior | Components | E2E Tested |
|---|----------|---------|-------------------|------------|------------|
| C1 | Send a message | Any text | Agent processes via LLM, responds | Adapter → EventBus → SecurityPipeline → Dispatcher → Queue → AgentLoop → LLM | Yes (pipeline-e2e) |
| C2 | Clear conversation | `/new` | History cleared, memories flushed if >2000 tokens, fresh start | CommandRouter, ConversationMemory, MemoryFlusher | Partial (unit only) |
| C3 | Clear and continue | `/new tell me a joke` | History cleared, then "tell me a joke" processed | CommandRouter, forwarding | Yes (unit) |
| C4 | Context compaction | Long conversation exceeds `MAX_CONTEXT_TOKENS` | History auto-summarized, conversation continues coherently | ContextCompactor, MemoryFlusher | No |
| C5 | Streaming response | Any message (when LLM supports streaming) | Console: real-time output. Telegram: placeholder edited in-place at 1.5s intervals | AgentLoop, Adapter.handleStreamEvent | No |

### 2.2 File & Code Operations

| # | Use Case | Trigger | Expected Behavior | Components | E2E Tested |
|---|----------|---------|-------------------|------------|------------|
| F1 | Read a file | "Show me config.js" | Agent calls `read_file`, returns contents | ToolExecutor, Sandbox, fs-tools | Yes (fs-tools) |
| F2 | Write a file | "Create a file hello.txt" | Approval required → user approves → file created | ToolExecutor, ApprovalManager, Sandbox | Yes (approval-flow) |
| F3 | Edit a file | "Change X to Y in file.js" | Approval required → targeted search-and-replace | ToolExecutor, ApprovalManager, Sandbox | Partial (fs-tools unit) |
| F4 | Search files | "Find all .ts files" | Agent calls `file_search` with glob | ToolExecutor, Sandbox | Yes (fs-tools) |
| F5 | Search content | "Find usages of foo" | Agent calls `grep_search` | ToolExecutor, Sandbox | Yes (fs-tools) |
| F6 | List directory | "What's in the workspace?" | Agent calls `list_directory` | ToolExecutor, Sandbox | Yes (fs-tools) |

### 2.3 Shell & Process Management

| # | Use Case | Trigger | Expected Behavior | Components | E2E Tested |
|---|----------|---------|-------------------|------------|------------|
| S1 | Run a command | "Run npm test" | Approval required → command executes → output returned | ToolExecutor, ApprovalManager, ProcessManager | Yes (approval-flow, shell-tools) |
| S2 | Start background process | "Start the dev server" | Approval required → process spawned → PID returned | ProcessManager, shell-tools | Yes (shell-tools) |
| S3 | Check process status | "Is the dev server running?" | Agent calls `check_process`, shows tail output | ProcessManager | Yes (shell-tools) |
| S4 | Kill a process | "Stop the dev server" | Approval required → SIGTERM sent | ProcessManager | Yes (shell-tools) |
| S5 | Command timeout | "Run a very long build" | Hits 120s timeout → error returned → agent handles | ProcessManager, AgentLoop | No |

### 2.4 Memory & Knowledge

| # | Use Case | Trigger | Expected Behavior | Components | E2E Tested |
|---|----------|---------|-------------------|------------|------------|
| M1 | Save a fact | "Remember that the API key is in vault" | Agent calls `save_memory` → stored as markdown + FTS indexed | PersistentMemory, MemorySearch | Partial (unit) |
| M2 | Recall a fact | "What do you know about the API key?" | Memory snippets pre-loaded into system prompt via search | MemorySearch, PromptBuilder | Partial (pipeline-e2e checks inclusion) |
| M3 | List memories | "What have you memorized?" | Agent calls `list_memories` → returns all keys | PersistentMemory | Partial (unit) |
| M4 | Memory flush on /new | `/new` after long conversation | Important facts saved before history is cleared | MemoryFlusher, LLM, save_memory | Partial (unit) |

### 2.5 Delegation & Sub-Agents

| # | Use Case | Trigger | Expected Behavior | Components | E2E Tested |
|---|----------|---------|-------------------|------------|------------|
| D1 | Delegate a task | "Have Claude Code fix the tests" | Approval required → sub-agent spawned → task ID returned | DelegationManager, ProcessManager | Yes (delegation) |
| D2 | Check delegation status | "How's that task going?" | Agent calls `check_delegation` → status + output | DelegationManager | Yes (delegation) |
| D3 | Cancel delegation | "Cancel that task" | Approval required → SIGTERM to process | DelegationManager | Yes (delegation) |
| D4 | Delegation limit reached | 10+ concurrent delegations | "Delegation limit reached" error | DelegationManager | Yes (delegation) |

### 2.6 Agent Profiles

| # | Use Case | Trigger | Expected Behavior | Components | E2E Tested |
|---|----------|---------|-------------------|------------|------------|
| A1 | Switch agent | `/agent coder` | Session binds to coder profile; persisted to history | CommandRouter, AgentRegistry, SessionManager, ConversationMemory | Partial (command-context) |
| A2 | List agents | `/agent list` | Returns list of available profiles with descriptions (not persisted) | CommandRouter, AgentRegistry | Partial (command-context) |
| A3 | Reset to default | `/agent default` | Session reverts to SOUL.md, default tools; persisted to history | CommandRouter, SessionManager, ConversationMemory | Partial (command-context) |
| A4 | Unknown agent | `/agent nonexistent` | Error: "Agent profile not found" (not persisted) | CommandRouter, AgentRegistry | Partial (command-context) |
| A5 | Agent tool whitelist | Message after `/agent coder` | Only tools in profile's whitelist are available | HostDispatcher, ToolPolicy | No |

### 2.7 Model Switching

| # | Use Case | Trigger | Expected Behavior | Components | E2E Tested |
|---|----------|---------|-------------------|------------|------------|
| L1 | Show current model | `/model` | Displays the active LLM model name; persisted to history | CommandRouter, LLMProvider, ConversationMemory | Yes (model-command, command-context) |
| L2 | Switch model | `/model qwen2` | Model switched, confirmation with old → new names; persisted to history | CommandRouter, LLMProvider, ConversationMemory | Yes (model-command, command-context) |
| L3 | Switch model (no provider) | `/model` when llmProvider unavailable | Error: "LLM provider is not available" (not persisted) | CommandRouter | Yes (model-command, command-context) |

### 2.8 Skills

| # | Use Case | Trigger | Expected Behavior | Components | E2E Tested |
|---|----------|---------|-------------------|------------|------------|
| K1 | Trigger skill | `/weather London` | Skill instructions injected into system prompt, LLM uses skill tools | SkillLoader, HostDispatcher, PromptBuilder | Partial (pipeline-e2e checks matching) |
| K2 | Skill not found | `/unknown` | No skill matches → message passed to LLM as-is | HostDispatcher | Implicit |

### 2.9 Workspace State & Continuity

| # | Use Case | Trigger | Expected Behavior | Components | E2E Tested |
|---|----------|---------|-------------------|------------|------------|
| WS1 | Initialize project state | First interaction in a new project with no `project_state` | Agent sees project hint in prompt, creates `project_state` via `save_memory` (routed to active project) | StateBootstrap, ProjectManager, PromptBuilder, save_memory | Yes (workspace-state-e2e) |
| WS2 | Resume after conversation reset | After `/new` when a project is active | System prompt includes active project's workspace state; agent continues without re-asking context | StateBootstrap, ProjectManager, HostDispatcher, PromptBuilder | Yes (workspace-state-e2e) |
| WS3 | Self-audit past decisions | "Why did we choose X?" | Agent searches `decision_journal` via `search_memory`, provides reasoning | MemorySearch, decision_journal convention | No |
| WS4 | Update project state | Agent completes task or makes decision | Agent calls `save_memory` to update `project_state` and/or append to `decision_journal` (routed to active project) | ProjectManager, PersistentMemory, save_memory | No |
| WS5 | Switch project | `/project panama-trip` | Active project switched; project state injected into system prompt on next turn | ProjectManager, CommandRouter, StateBootstrap | No |
| WS6 | Agent auto-switches project | User starts discussing a new topic | Agent calls `switch_project` tool; new project's state (or empty state) injected | ProjectManager, switch_project tool, StateBootstrap | No |
| WS7 | List projects | `/project list` | Lists all projects with active indicator | ProjectManager, CommandRouter | No |

### 2.10 Security & Safety

| # | Use Case | Trigger | Expected Behavior | Components | E2E Tested |
|---|----------|---------|-------------------|------------|------------|
| P1 | Rate limit exceeded | User sends 21+ messages in 60 seconds | "Rate limit exceeded. Please wait N seconds." | RateLimiter | No |
| P2 | Approval required | User invokes write/shell tool | `[APPROVAL_REQUIRED]` → user sends `/approve` → tool executes | ApprovalManager, ToolExecutor, CommandRouter | Yes (approval-flow) |
| P3 | Approval rejected | User invokes write/shell tool, rejects | `[APPROVAL_REQUIRED]` → user sends `/reject` → "Rejected" | ApprovalManager, CommandRouter | Yes (approval-flow) |
| P4 | Sandbox violation | Agent tries to access file outside workspace | "Path is outside the workspace" error | Sandbox | Yes (sandbox) |

### 2.11 Scheduling

| # | Use Case | Trigger | Expected Behavior | Components | E2E Tested |
|---|----------|---------|-------------------|------------|------------|
| T1 | Scheduled task runs | Cron schedule fires | Task executes with configured tools, result logged | TaskScheduler, Runner | Partial (scheduler unit) |
| T2 | Overlapping task skipped | Task still running when next tick fires | Skip logged, no duplicate execution | TaskScheduler | Partial (heartbeat-runner) |
| T3 | Task result delivery | Scheduled task completes | Result should be deliverable to a user/channel | TaskScheduler, Adapter | No (possible feature gap) |

### 2.12 Telegram-Specific

| # | Use Case | Trigger | Expected Behavior | Components | E2E Tested |
|---|----------|---------|-------------------|------------|------------|
| TG1 | Private message | User sends message in Telegram | Message normalized, processed in shared session | TelegramAdapter, SessionManager | Yes (pipeline-e2e) |
| TG2 | [Removed — no group chats] | — | — | — | — |
| TG3 | Command with @BotName | `/approve@AgentCoreBot` | @BotName stripped, command recognized | CommandRouter | Yes (context-management, approval-flow) |
| TG4 | Photo attachment | User sends photo with caption | Photo file_id extracted, caption as content | telegram-normalize | No |
| TG5 | Document attachment | User sends PDF/file | Document metadata extracted | telegram-normalize | No |
| TG6 | Voice message | User sends voice note | Voice file_id + duration extracted | telegram-normalize | No |
| TG7 | Streaming response | Agent generates long reply | Placeholder "..." → edit at 1.5s intervals → final edit | TelegramAdapter._stream* | No |
| TG8 | Long response chunking | Response > 4096 chars | Split at paragraph boundaries, multiple messages | TelegramSender | No |
| TG9 | Inline keyboard callback | User taps inline button | Callback data processed as message | TelegramAdapter, normalizeCallbackQuery | No |
| TG10 | Markdown parse failure | Response has invalid Markdown | Fallback to plain text | TelegramAdapter._flushEdit | No |

### 2.13 Cross-Adapter

| # | Use Case | Trigger | Expected Behavior | Components | E2E Tested |
|---|----------|---------|-------------------|------------|------------|
| X1 | Same user, different adapters | User talks via console then Telegram | Same session, shared conversation history and project context | SessionManager | No (unified session ID — [Spec 32](32-single-user-migration.md)) |
| X2 | Outbound routing | Response to Telegram user | Message routed to correct adapter by channelId | AdapterRegistry, EventBus | Yes (pipeline-e2e) |

### 2.14 Error Recovery

| # | Use Case | Trigger | Expected Behavior | Components | E2E Tested |
|---|----------|---------|-------------------|------------|------------|
| E1 | LLM API error | Provider returns 500 or timeout | Agent returns friendly error, status: error | AgentLoop | Partial (unit) |
| E2 | Tool execution error | Tool handler throws | Error returned as tool_result, LLM handles | ToolExecutor, AgentLoop | Yes (pipeline-e2e) |
| E3 | Max iterations reached | Agent loop hits 25 iterations | "Reached maximum processing steps" response | AgentLoop | Partial (unit) |
| E4 | Graceful shutdown | SIGINT/SIGTERM | Queue drains, processes killed, adapters stop, DB closed | index.js shutdown handler | Partial (pipeline-e2e) |

---

## 3. Coverage Summary

| Category | Total | E2E Tested | Partial | Not Tested |
|----------|-------|------------|---------|------------|
| Chat & Conversation | 5 | 1 | 1 | 3 |
| File & Code | 6 | 5 | 1 | 0 |
| Shell & Process | 5 | 4 | 0 | 1 |
| Memory & Knowledge | 4 | 0 | 4 | 0 |
| Delegation | 4 | 4 | 0 | 0 |
| Agent Profiles | 5 | 0 | 4 | 1 |
| Model Switching | 3 | 3 | 0 | 0 |
| Skills | 2 | 0 | 2 | 0 |
| Workspace State & Projects | 7 | 2 | 0 | 5 |
| Security & Safety | 4 | 2 | 0 | 2 |
| Scheduling | 3 | 0 | 2 | 1 |
| Telegram-Specific | 9 | 1 | 1 | 7 |
| Cross-Adapter | 2 | 1 | 0 | 1 |
| Error Recovery | 4 | 1 | 3 | 0 |
| **Total** | **63** | **24** | **14** | **25** |

---

## 4. Priority for E2E Test Creation

**P0 — Write first** (silent production failures):
WS5-WS7 (project switching), X1 (shared session across adapters), C4 (compaction), P1 (rate limiting)

**P1 — Write next** (breaks on real usage):
A1-A5 (agent profiles), C2/M4 (memory flush), C5/TG7 (streaming), S5 (timeout), TG4-TG6 (attachments)

**P2 — Write eventually** (edge cases):
TG8-TG10 (chunking, callbacks, markdown), T3 (task delivery), E1 (LLM error in pipeline)

## 5. Resolved Inconsistencies

The following inconsistencies from the old multi-user model have been resolved by [Spec 32](32-single-user-migration.md):

- **Unified session ID** — `resolveSessionId()` now returns `'user:default'` for all adapters (single shared session).
- **Simplified security** — Role-based access control removed. `PermissionManager` always allows; `ToolPolicy` returns all tools. Approval workflow ([Spec 19](19-approval-workflow.md)) is the safety mechanism.
- **Global rate limiting** — Single global bucket instead of per-user rate limiting.
- **`AUTO_APPROVE_USERS` removed** — Config variable no longer exists (silently ignored if set in `.env`).
- **`user_aliases` table** — Migration remains in place (safe) but table is no longer referenced.
- Specs 01, 06, 07, 09, and ARCHITECTURE.md have been updated to reflect the single-user model.
