import { createExecutionRequest } from './runner/execution-request.js';

/**
 * Host-side request building and result finalization.
 * Extracts host concerns (session, tools, memory, skills, guardrails, persistence, delivery)
 * from the agent loop into a single orchestration point.
 */
export class HostDispatcher {
  constructor({
    sessionManager,
    toolPolicy,
    toolRegistry,
    memorySearch,
    skillLoader,
    permissionManager,
    historyPruner,
    eventBus,
    logger,
    config,
    agentRegistry,
    llmProvider,
    stateBootstrap,
  }) {
    this.sessionManager = sessionManager;
    this.toolPolicy = toolPolicy;
    this.toolRegistry = toolRegistry;
    this.memorySearch = memorySearch;
    this.skillLoader = skillLoader || null;
    this.permissionManager = permissionManager || null;
    this.historyPruner = historyPruner || null;
    this.eventBus = eventBus;
    this.logger = logger;
    this.config = config;
    this.agentRegistry = agentRegistry || null;
    this.llmProvider = llmProvider || null;
    this.stateBootstrap = stateBootstrap || null;
  }

  /**
   * Build an ExecutionRequest from a sanitized inbound message.
   */
  async buildRequest(sanitizedMessage, origin = 'user_message') {
    const sessionId = this.sessionManager.resolveSessionId(sanitizedMessage);
    const session = this.sessionManager.getOrCreate(
      sessionId, sanitizedMessage.userId, sanitizedMessage.channelId, sanitizedMessage.userName
    );
    session.lastUserMessage = sanitizedMessage.content;
    if (this.llmProvider) {
      if (!session.metadata) session.metadata = {};
      session.metadata.activeModel = this.llmProvider.getModel();
    }

    let history = this.sessionManager.loadHistory(sessionId);
    if (this.historyPruner) {
      history = this.historyPruner.prune(history);
    }

    // Resolve agent profile (if session is bound to one)
    let agentProfile = null;
    if (this.agentRegistry && session.metadata?.agentName) {
      agentProfile = this.agentRegistry.get(session.metadata.agentName);
    }

    const effectiveTools = this.toolPolicy
      ? this.toolPolicy.getEffectiveToolNames(sanitizedMessage.userId, session)
      : null;
    const allowedToolNames = effectiveTools
      ? new Set(effectiveTools.map(t => t.name))
      : null;

    // If agent profile restricts tools, intersect with role-based policy
    let effectiveToolNames = allowedToolNames;
    if (agentProfile?.tools && allowedToolNames) {
      const profileSet = new Set(agentProfile.tools);
      effectiveToolNames = new Set([...allowedToolNames].filter(t => profileSet.has(t)));
    } else if (agentProfile?.tools) {
      effectiveToolNames = new Set(agentProfile.tools);
    }

    const toolSchemas = this.toolRegistry.getSchemas(effectiveToolNames);

    let skillInstructions = null;
    if (this.skillLoader) {
      for (const skill of this.skillLoader.getLoadedSkills()) {
        if (skill.trigger && sanitizedMessage.content.startsWith(skill.trigger)) {
          skillInstructions = skill.instructions;
          break;
        }
      }
    }

    let memorySnippets = [];
    try {
      if (this.memorySearch) {
        memorySnippets = this.memorySearch.search(sanitizedMessage.content, 5)
          .map(r => ({ key: r.key, content: r.content.substring(0, 300), metadata: r.metadata }));
      }
    } catch { /* non-critical */ }

    // Workspace state scan (Spec 29)
    let workspaceState = null;
    try {
      if (this.stateBootstrap) {
        workspaceState = await this.stateBootstrap.scan();
      }
    } catch { /* non-critical */ }

    return createExecutionRequest({
      origin,
      sessionId,
      userId: sanitizedMessage.userId,
      channelId: sanitizedMessage.channelId,
      userName: sanitizedMessage.userName || null,
      sessionMetadata: {
        ...session.metadata,
        sessionId,
        userId: sanitizedMessage.userId,
        channelId: sanitizedMessage.channelId,
        userName: sanitizedMessage.userName || null,
        agentProfile: agentProfile ? { name: agentProfile.name, soul: agentProfile.soul } : null,
      },
      history,
      userContent: sanitizedMessage.content,
      toolSchemas,
      allowedToolNames: effectiveToolNames,
      skillInstructions,
      memorySnippets,
      workspaceState,
      maxIterations: this.config.maxToolIterations,
    });
  }

  /**
   * Finalize an ExecutionResult: guardrails, persistence, delivery.
   */
  async finalize(request, result, originalMessage) {
    // 1. Guardrails
    let content = result.content;
    if (this.permissionManager) {
      const guardrail = this.permissionManager.checkModelGuardrails(content);
      content = guardrail.content;
    }

    // 2. Persist (with guardrailed content applied to the final assistant message)
    if (result.newMessages && result.newMessages.length > 0) {
      const messages = [...result.newMessages];
      if (content) {
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === 'assistant' && typeof messages[i].content === 'string') {
            messages[i] = { ...messages[i], content };
            break;
          }
        }
      }
      this.sessionManager.appendMessages(request.sessionId, messages);
    }

    // 3. Deliver
    const outbound = {
      sessionId: originalMessage?.sessionId || request.sessionId,
      channelId: request.channelId,
      userId: request.userId,
      content,
      replyTo: originalMessage?.id || null,
      metadata: {
        toolsUsed: result.toolsUsed || [],
        tokenUsage: result.tokenUsage || { inputTokens: 0, outputTokens: 0 },
        processingTimeMs: result.durationMs || 0,
      },
    };

    this.eventBus.emit('message:outbound', outbound);

    return outbound;
  }
}
