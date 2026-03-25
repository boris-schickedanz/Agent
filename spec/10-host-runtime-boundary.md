# Spec 10 — Host/Runtime Boundary

> Status: **Draft** | Owner: — | Last updated: 2026-03-25

## 1. Purpose

Define the architectural split between the **host** (control plane) and the **runtime** (execution plane) within AgentCore. The host owns adapters, security, persistence, scheduling, and delivery. The runtime owns prompt construction, the ReAct loop, and tool execution. A single **runner** abstraction bridges the two.

This spec is the foundation for specs 11–14 and blocks all implementation work.

## 2. Goals

1. Separate control-plane concerns (ingress, egress, identity, policy, persistence, scheduling) from execution concerns (LLM calls, tool invocations, context management).
2. Introduce a runner interface so the host never calls `AgentLoop.processMessage` directly.
3. Keep the first milestone behaviorally identical to the current system by providing a `LocalRunner` that wraps the existing `AgentLoop`.
4. Make the architecture forward-compatible with remote, containerized, or sandboxed runners without requiring them in the first step.

## 3. Non-Goals

- Containerization or sandbox implementation.
- Multi-runner selection logic or routing.
- Distributed queue or external orchestrator integration.
- Changes to the LLM provider interface, adapter interface, or database schema.

## 4. Definitions

| Term | Definition |
|------|-----------|
| **Host** | The long-lived process that owns adapters, the event bus, the security pipeline, the message queue, persistence (SQLite), scheduling, and outbound delivery. It is the only component that communicates with external systems. |
| **Runtime** | The execution module that receives an `ExecutionRequest`, runs the ReAct loop (LLM calls + tool execution), and returns an `ExecutionResult`. It has no direct access to adapters, the event bus, or persistence stores. |
| **Runner** | The interface the host uses to invoke the runtime. The host constructs an `ExecutionRequest` and calls `runner.execute(request)`. The runner returns an `ExecutionResult`. |
| **LocalRunner** | The initial runner implementation. It instantiates or wraps the existing `AgentLoop` in-process and translates between `ExecutionRequest`/`ExecutionResult` and the current `NormalizedMessage`/`OutboundMessage` shapes. |
| **ExecutionRequest** | A self-contained description of work the host wants the runtime to perform. Defined in spec 11. |
| **ExecutionResult** | The outcome of a runtime execution. Defined in spec 11. |

## 5. Ownership Matrix

The following table classifies every major responsibility in the current system as host-owned or runtime-owned after the refactor.

| Responsibility | Owner | Current Location | Notes |
|----------------|-------|------------------|-------|
| Adapter lifecycle (start/stop) | Host | `index.js`, `AdapterRegistry` | Unchanged |
| Inbound message normalization | Host | Adapters | Unchanged |
| Security pipeline (rate limit, permissions, sanitization) | Host | `index.js` event handler | Unchanged |
| Message queueing and serialization | Host | `MessageQueue` | Unchanged |
| Session resolution and creation | Host | `SessionManager` | Moves from agent loop to host; host provides session context in `ExecutionRequest` |
| Conversation history loading | Host | `SessionManager` → `ConversationMemory` | Host loads history and includes it in `ExecutionRequest` |
| Persistent memory (storage and FTS index) | Host | `PersistentMemory`, `MemorySearch` | Host owns the store; runtime accesses it through brokered tools (see spec 13) |
| System prompt assembly | Runtime | `PromptBuilder` | Runtime builds the prompt from data provided in the request |
| Tool resolution (policy → schemas) | Host | `ToolPolicy`, `ToolRegistry` | Host resolves allowed tools and includes schemas in the request |
| ReAct loop (LLM + tool iteration) | Runtime | `AgentLoop` | Core runtime responsibility |
| Tool execution | Runtime | `ToolExecutor` | Executes within the runtime; some tools may be brokered (spec 13) |
| Context compaction | Runtime | `ContextCompactor` | Operates on the in-flight message array |
| Outbound message emission | Host | `AgentLoop` → `EventBus` | Moves from agent loop to host; host emits after runner returns |
| Conversation history persistence | Host | `SessionManager` → `ConversationMemory` | Host persists after runner returns |
| Outbound guardrails | Host | `PermissionManager.checkModelGuardrails` | Host applies after runner returns |
| Heartbeat scheduling | Host | `HeartbeatScheduler` | Host creates `ExecutionRequest` objects instead of calling `agentLoop.processMessage` |
| Skill loading | Host | `SkillLoader` | Host loads skills and provides instructions in the request |
| Graceful shutdown | Host | `index.js` | Unchanged |

## 6. Architectural Diagrams

### 6.1 Current Flow

```
Adapter → EventBus(message:inbound) → Security Pipeline → MessageQueue → AgentLoop.processMessage()
                                                                              ↓
                                                                    Session resolution
                                                                    History loading
                                                                    Tool resolution
                                                                    Prompt building
                                                                    ReAct loop (LLM + tools)
                                                                    Persistence
                                                                    Guardrails
                                                                              ↓
                                                                    EventBus(message:outbound) → AdapterRegistry → Adapter
```

Key observation: `AgentLoop` currently handles both runtime concerns (ReAct loop) and host concerns (session resolution, history loading, persistence, guardrails, event emission).

### 6.2 Target Flow

```
Adapter → EventBus(message:inbound) → Security Pipeline → MessageQueue
                                                              ↓
                                                         Host Dispatcher
                                                              ↓
                                                    Session resolution
                                                    History loading
                                                    Tool resolution
                                                    Build ExecutionRequest
                                                              ↓
                                                    Runner.execute(request)
                                                              ↓
                                                         [Runtime]
                                                    Prompt building
                                                    ReAct loop (LLM + tools)
                                                    Context compaction
                                                              ↓
                                                    ExecutionResult returned
                                                              ↓
                                                         Host Dispatcher
                                                              ↓
                                                    Guardrails
                                                    Persistence
                                                    EventBus(message:outbound) → AdapterRegistry → Adapter
```

Key change: the host builds the `ExecutionRequest` before invoking the runner, and handles persistence and delivery after the runner returns.

### 6.3 Heartbeat and Scheduled Tasks (Target)

```
HeartbeatScheduler.tick()
        ↓
  Parse HEARTBEAT.md tasks
  Build ExecutionRequest (origin: scheduled_task)
        ↓
  Runner.execute(request)
        ↓
  Host handles result (logging, optional delivery)
```

The heartbeat no longer calls `agentLoop.processMessage` directly. It produces an `ExecutionRequest` like any other dispatch path.

### 6.4 Delegated Agent (Future, Target)

```
Host receives delegated-agent request (e.g., from a parent agent or remote trigger)
        ↓
  Build ExecutionRequest (origin: delegated_agent)
        ↓
  Runner.execute(request)
        ↓
  Host handles result (return to caller, persist, deliver)
```

The runner contract supports this without a second runner type. Only the origin field and host-side dispatch logic differ.

## 7. Migration Constraints

1. **LocalRunner preserves current behavior.** The first implementation wraps `AgentLoop` and translates between the new request/result shapes and the existing internal shapes. No behavioral change is observable from any adapter.
2. **No container requirement.** The boundary is a code-level abstraction in the first step. It may later be reinforced with process isolation or containers.
3. **Host concerns must not leak into the runner.** The runner must not import `EventBus`, `AdapterRegistry`, `SessionManager`, `ConversationMemory`, or `PersistentMemory` directly. If the runtime needs to access a host resource, it does so through a brokered tool or an explicit parameter in the `ExecutionRequest`.
4. **Runtime concerns must not leak into the host.** The host must not construct LLM messages, call the LLM provider, or execute tools directly. These are runtime responsibilities.
5. **Session and history are provided, not fetched.** The runtime receives conversation history and session metadata as part of the `ExecutionRequest`. It does not query the database.

## 8. Scope Boundary

This spec defines the conceptual split and ownership. It does not define:

- The `ExecutionRequest`/`ExecutionResult` shapes (see spec 11).
- The runner interface methods (see spec 11).
- Queueing, parallelism, or scheduling behavior (see spec 12).
- Tool classification by trust boundary (see spec 13).
- The implementation sequence (see spec 14).

## 9. Design Decisions

| Decision | Rationale |
|----------|-----------|
| Single runner, not multiple | A single runner contract is sufficient for local, scheduled, and delegated execution. Multiple runners add routing complexity without current justification. |
| Host loads history before invoking runner | Moves persistence access out of the runtime. The runtime operates on in-memory data only. |
| Host applies guardrails after runner returns | Keeps output filtering as a host policy concern, not a runtime concern. |
| Session resolution moves to host | Session identity is a host concern (tied to adapters and persistence). The runtime receives session metadata, not a session key to resolve. |
| EventBus emission moves to host | The runtime should not know about the event bus or adapter routing. The host emits `message:outbound` after receiving the `ExecutionResult`. |
| Prompt building stays in runtime | The prompt is constructed from data in the request (session metadata, tool schemas, skill instructions, memory snippets). The runtime assembles these into the system prompt. Assembly logic is tightly coupled with the ReAct loop and context compaction. |

## 10. Extension Points

- **ContainerRunner:** A future runner that starts a sandboxed process or container, serializes the `ExecutionRequest`, and deserializes the `ExecutionResult`. The host code does not change.
- **RemoteRunner:** A future runner that sends the request to a remote worker over HTTP or a message queue. Same host interface.
- **Multi-runner routing:** A future host component that selects a runner based on request properties (e.g., tool requirements, origin, or resource limits). The runner interface remains the same.
