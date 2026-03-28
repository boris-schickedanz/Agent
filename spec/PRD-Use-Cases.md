# Spec 24 — Use Cases & Product Requirements

> Status: **Active** | Owner: — | Last updated: 2026-03-27

This document is the canonical inventory of everything a user can do with AgentCore. It describes flows from the user's perspective, maps each to the components involved, and tracks end-to-end test coverage. Technical specs describe *how* subsystems work; this PRD describes *what the user experiences*.

## 1. User Personas

| Role | Registration | Tool access | Approval | Description |
|------|-------------|-------------|----------|-------------|
| **Admin** | Manual DB entry | All tools | Bypassed | Full control. Manages other users. |
| **User** | Auto (`AUTO_APPROVE_USERS=true`) or promoted from pending | Standard tools (read + write) | Required for write tools | Normal user with approval-gated write access. |
| **Pending** | Auto (first message, `AUTO_APPROVE_USERS=false`) | Minimal (`get_current_time` only) | N/A | New, unverified user. Must be promoted to user/admin. |
| **Blocked** | Manual DB entry | None | N/A | Denied all access. |

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
| WS1 | Initialize workspace state | First substantive interaction with no `project_state` memory | Agent sees bootstrapping hint in prompt, creates `project_state` via `save_memory` | StateBootstrap, PromptBuilder, save_memory | No |
| WS2 | Resume from prior session | New session when `project_state` exists | System prompt includes workspace state; agent continues without re-asking context | StateBootstrap, HostDispatcher, PromptBuilder | No |
| WS3 | Self-audit past decisions | "Why did we choose X?" | Agent searches `decision_journal` via `search_memory`, provides reasoning | MemorySearch, decision_journal convention | No |
| WS4 | Update project state | Agent completes task or makes decision | Agent calls `save_memory` to update `project_state` and/or append to `decision_journal` | PersistentMemory, save_memory | No |

### 2.10 Security & Permissions

| # | Use Case | Trigger | Expected Behavior | Components | E2E Tested |
|---|----------|---------|-------------------|------------|------------|
| P1 | New user first message | Unknown userId sends message | Auto-registered as pending or user → appropriate tool set | PermissionManager, ToolPolicy | No |
| P2 | Blocked user | Blocked user sends message | "Access denied" response | PermissionManager | No |
| P3 | Pending user tries write tool | Pending user asks to write file | Tool not available (minimal profile) → agent can only use get_current_time | ToolPolicy, HostDispatcher | No |
| P4 | Rate limit exceeded | User sends 21+ messages in 60 seconds | "Rate limit exceeded. Please wait N seconds." | RateLimiter | No |
| P5 | Approval required | Non-admin invokes write tool | `[APPROVAL_REQUIRED]` → user sends `/approve` → tool executes | ApprovalManager, ToolExecutor, CommandRouter | Yes (approval-flow) |
| P6 | Approval rejected | Non-admin invokes write tool, rejects | `[APPROVAL_REQUIRED]` → user sends `/reject` → "Rejected" | ApprovalManager, CommandRouter | Yes (approval-flow) |
| P7 | Admin bypasses approval | Admin invokes write tool | Tool executes immediately, no approval prompt | ApprovalManager | Yes (approval-flow) |
| P8 | Sandbox violation | Agent tries to access file outside workspace | "Path is outside the workspace" error | Sandbox | Yes (sandbox) |

### 2.11 Scheduling

| # | Use Case | Trigger | Expected Behavior | Components | E2E Tested |
|---|----------|---------|-------------------|------------|------------|
| T1 | Scheduled task runs | Cron schedule fires | Task executes with configured tools, result logged | TaskScheduler, Runner | Partial (scheduler unit) |
| T2 | Overlapping task skipped | Task still running when next tick fires | Skip logged, no duplicate execution | TaskScheduler | Partial (heartbeat-runner) |
| T3 | Task result delivery | Scheduled task completes | Result should be deliverable to a user/channel | TaskScheduler, Adapter | No (possible feature gap) |

### 2.12 Telegram-Specific

| # | Use Case | Trigger | Expected Behavior | Components | E2E Tested |
|---|----------|---------|-------------------|------------|------------|
| TG1 | Private message | User sends message in private chat | Session: `telegram:{chatId}`, full access | TelegramAdapter, SessionManager | Yes (pipeline-e2e) |
| TG2 | Group message | User sends message in group | Session: `telegram:group:{chatId}`, isolated from private | TelegramAdapter, SessionManager | Partial (session-identity unit) |
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
| X1 | Same user, different adapters | User talks via console then Telegram | Same canonical session if aliases configured | SessionManager, user_aliases | No |
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
| Workspace State | 4 | 0 | 0 | 4 |
| Security & Permissions | 8 | 3 | 0 | 5 |
| Scheduling | 3 | 0 | 2 | 1 |
| Telegram-Specific | 10 | 1 | 1 | 8 |
| Cross-Adapter | 2 | 1 | 0 | 1 |
| Error Recovery | 4 | 1 | 3 | 0 |
| **Total** | **65** | **23** | **14** | **28** |

**35% fully tested, 22% partially tested, 43% not tested.**

---

## 4. Priority for E2E Test Creation

**P0 — Write first** (silent production failures):
P1, P2, P3, P4 (security flows), TG4-TG6 (attachments), C4 (compaction)

**P1 — Write next** (breaks on real usage):
A1-A5 (agent profiles), C2/M4 (memory flush), C5/TG7 (streaming), TG2 (group isolation), S5 (timeout)

**P2 — Write eventually** (edge cases):
TG8-TG10 (chunking, callbacks, markdown), X1 (cross-adapter), T3 (task delivery), E1 (LLM error in pipeline)
