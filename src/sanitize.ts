const SENSITIVE_KEYS = new Set([
  "access_token",
  "token",
  "authorization",
  "password",
  "secret",
  "api_key",
  "apikey",
  "private_key",
  "credential"
]);

export function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitive);

  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEYS.has(key.toLowerCase()) ? "[REDACTED]" : redactSensitive(child);
    }
    return out;
  }

  return value;
}

export function sanitizeBodhiRun(run: Record<string, unknown>): Record<string, unknown> {
  return {
    id: run.id ?? run.runId,
    status: run.status,
    startedAt: run.startedAt ?? run.createdAt ?? null,
    finishedAt: run.finishedAt ?? run.completedAt ?? run.updatedAt ?? null,
    summary: run.summary ?? null
  };
}
