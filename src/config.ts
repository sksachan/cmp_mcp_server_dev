export type Config = {
  nodeEnv: string;
  port: number;
  logLevel: string;
  mcpSharedSecret: string;
  bodhiApiBaseUrl: string;
  bodhiPatToken: string;
  bodhiWorkflowId: string;
  bodhiTaskId: string;
  bodhiHitlPollIntervalMs: number;
  bodhiRunPollIntervalMs: number;
  bodhiTimeoutMs: number;
  publicBaseUrl?: string;
  oauthLoginPassword: string;
  oauthAccessTokenTtlSeconds: number;
  executorCommandTimeoutMs: number;
};

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Environment variable ${name} must be a positive number`);
  }
  return parsed;
}

export function loadConfig(): Config {
  return {
    nodeEnv: process.env.NODE_ENV ?? "development",
    port: numberFromEnv("PORT", 3000),
    logLevel: process.env.LOG_LEVEL ?? "info",
    mcpSharedSecret: required("MCP_SHARED_SECRET"),
    bodhiApiBaseUrl: (process.env.BODHI_API_BASE_URL ?? "https://sapientaiproducts.com/save/api/v1").replace(/\/+$/, ""),
    bodhiPatToken: required("BODHI_PAT_TOKEN"),
    bodhiWorkflowId: process.env.BODHI_WORKFLOW_ID ?? "8598b371-272b-44ca-b7c9-3ff772e96477",
    bodhiTaskId: process.env.BODHI_TASK_ID ?? "9664fd27-c7e6-4595-963e-c04c6ecd59e8",
    bodhiHitlPollIntervalMs: numberFromEnv("BODHI_HITL_POLL_INTERVAL_MS", 3000),
    bodhiRunPollIntervalMs: numberFromEnv("BODHI_RUN_POLL_INTERVAL_MS", 20000),
    bodhiTimeoutMs: numberFromEnv("BODHI_TIMEOUT_MS", 1800000),
    publicBaseUrl: process.env.PUBLIC_BASE_URL?.replace(/\/+$/, ""),
    oauthLoginPassword: process.env.OAUTH_LOGIN_PASSWORD ?? required("MCP_SHARED_SECRET"),
    oauthAccessTokenTtlSeconds: numberFromEnv("OAUTH_ACCESS_TOKEN_TTL_SECONDS", 86400),
    executorCommandTimeoutMs: numberFromEnv("EXECUTOR_COMMAND_TIMEOUT_MS", 900000)
  };
}
