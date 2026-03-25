import 'dotenv/config';
import { resolve } from 'path';

export const config = Object.freeze({
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  agentName: process.env.AGENT_NAME || 'AgentCore',
  dataDir: resolve(process.env.DATA_DIR || './data'),
  logLevel: process.env.LOG_LEVEL || 'info',
  maxToolIterations: parseInt(process.env.MAX_TOOL_ITERATIONS || '25', 10),
  heartbeatIntervalMs: parseInt(process.env.HEARTBEAT_INTERVAL_MINUTES || '30', 10) * 60_000,
  rateLimitPerMinute: parseInt(process.env.RATE_LIMIT_MESSAGES_PER_MINUTE || '20', 10),
  maxContextTokens: parseInt(process.env.MAX_CONTEXT_TOKENS || '100000', 10),
  compactionThreshold: parseInt(process.env.COMPACTION_THRESHOLD || '80000', 10),
  autoApproveUsers: process.env.AUTO_APPROVE_USERS === 'true',
  masterKey: process.env.MASTER_KEY || '',
  model: process.env.MODEL || 'claude-sonnet-4-20250514',
});
