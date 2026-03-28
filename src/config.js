import 'dotenv/config';
import { resolve } from 'path';

export const config = Object.freeze({
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  anthropicAuthToken: process.env.ANTHROPIC_AUTH_TOKEN || '',
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  agentName: process.env.AGENT_NAME || 'AgentCore',
  dataDir: resolve(process.env.DATA_DIR || './data'),
  logLevel: process.env.LOG_LEVEL || 'info',
  maxToolIterations: parseInt(process.env.MAX_TOOL_ITERATIONS || '25', 10),
  heartbeatIntervalMs: parseInt(process.env.HEARTBEAT_INTERVAL_MINUTES || '30', 10) * 60_000,
  rateLimitPerMinute: parseInt(process.env.RATE_LIMIT_MESSAGES_PER_MINUTE || '20', 10),
  maxContextTokens: parseInt(process.env.MAX_CONTEXT_TOKENS || '100000', 10),
  compactionThreshold: parseInt(process.env.COMPACTION_THRESHOLD || '80000', 10),
  compactionRetainMessages: parseInt(process.env.COMPACTION_RETAIN_MESSAGES || '10', 10),
  compactionMemoryFlush: process.env.COMPACTION_MEMORY_FLUSH !== 'false',
  pruneThreshold: parseInt(process.env.PRUNE_THRESHOLD || '4000', 10),
  pruneHead: parseInt(process.env.PRUNE_HEAD || '1500', 10),
  pruneTail: parseInt(process.env.PRUNE_TAIL || '1500', 10),
  autoApproveUsers: process.env.AUTO_APPROVE_USERS === 'true'
    ? true
    : process.env.AUTO_APPROVE_USERS && process.env.AUTO_APPROVE_USERS !== 'false'
      ? process.env.AUTO_APPROVE_USERS.split(',').map(s => s.trim()).filter(Boolean)
      : false,
  masterKey: process.env.MASTER_KEY || '',
  llmProvider: process.env.LLM_PROVIDER || 'anthropic',
  model: process.env.MODEL || 'claude-sonnet-4-20250514',
  ollamaHost: process.env.OLLAMA_HOST || 'http://localhost:11434',
  ollamaModel: process.env.OLLAMA_MODEL || 'llama3.1',
  ollamaApiKey: process.env.OLLAMA_API_KEY || '',
  consoleUserId: process.env.CONSOLE_USER_ID || 'console-user',

  // Phase 0: Sandbox & Audit
  workspaceDir: resolve(process.env.WORKSPACE_DIR || './workspace'),
  workspaceReadOnlyDirs: (process.env.WORKSPACE_READONLY_DIRS || '')
    .split(',').map(s => s.trim()).filter(Boolean),
  auditLogEnabled: process.env.AUDIT_LOG_ENABLED !== 'false',

  // Phase 1: Shell Execution
  shellContainer: process.env.SHELL_CONTAINER === 'true',
  shellContainerRuntime: process.env.SHELL_CONTAINER_RUNTIME || 'auto',
  shellContainerImage: process.env.SHELL_CONTAINER_IMAGE || 'agentcore-sandbox',
  maxBackgroundProcesses: parseInt(process.env.MAX_BACKGROUND_PROCESSES || '10', 10),
  defaultShellTimeoutMs: parseInt(process.env.DEFAULT_SHELL_TIMEOUT_SECONDS || '60', 10) * 1000,

  // Phase 2: Health & Daemon
  healthPort: parseInt(process.env.HEALTH_PORT || '9090', 10),
  healthBind: process.env.HEALTH_BIND || '127.0.0.1',

  // Container runtime
  containerMode: process.env.CONTAINER_MODE || 'auto',

  // Workspace state (Spec 29)
  workspaceStateEnabled: process.env.WORKSPACE_STATE_ENABLED !== 'false',
  workspaceStateMaxChars: parseInt(process.env.WORKSPACE_STATE_MAX_CHARS || '3000', 10),

  // Phase 3: Delegation & Dashboard
  maxDelegations: parseInt(process.env.MAX_DELEGATIONS || '10', 10),
  maxDelegationsPerSession: parseInt(process.env.MAX_DELEGATIONS_PER_SESSION || '3', 10),
  dashboardEnabled: process.env.DASHBOARD_ENABLED === 'true',
});
