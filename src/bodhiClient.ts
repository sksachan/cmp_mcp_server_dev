import type { Config } from "./config.js";
import type { DeployRequest, DeploymentResult } from "./schemas.js";

type Fetch = typeof fetch;

type HitlTask = {
  id: string;
  status?: string;
  task?: string;
  [key: string]: unknown;
};

type BodhiRun = {
  id?: string;
  runId?: string;
  status?: string;
  result?: unknown;
  output?: unknown;
  outputs?: unknown;
  [key: string]: unknown;
};

const FINAL_STATUSES = new Set(["completed", "finished", "done", "failed", "error"]);

export class BodhiClient {
  private readonly config: Config;
  private readonly fetchImpl: Fetch;

  constructor(config: Config, fetchImpl: Fetch = fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  async deployHelloWorld(request: DeployRequest): Promise<DeploymentResult> {
    if (!request.confirm_deploy) {
      return {
        status: "cancelled",
        run_id: "not-created",
        cluster_name: request.cluster_name,
        namespace: request.namespace,
        aws_region: request.aws_region,
        logs_summary: "Deployment was not started because confirm_deploy was false.",
        raw_bodhi_result: {
          skipped: true,
          reason: "confirm_deploy=false"
        }
      };
    }

    const runId = await this.createRun(request);
    const firstHitl = await this.waitForPendingHitl(runId);
    await this.submitHitl(runId, firstHitl.id, this.toDeploymentHitlResponse(request));

    const confirmationHitl = await this.waitForPendingHitl(runId, firstHitl.id);
    await this.submitHitl(runId, confirmationHitl.id, { Confirmation: "Yes" });

    const finalRun = await this.waitForCompletion(runId);
    return this.normalizeResult(runId, finalRun, request);
  }

  async createRun(request: DeployRequest): Promise<string> {
    const response = await this.request<BodhiRun>(`/tasks/${this.config.bodhiTaskId}/runs`, {
      method: "POST",
      body: JSON.stringify({
        runName: `MCP EKS deploy - ${request.app_name} - ${new Date().toISOString()}`,
        overrides: {
          workflow: this.config.bodhiWorkflowId
        }
      })
    });

    const runId = response.id ?? response.runId;
    if (!runId) {
      throw new Error(`Bodhi run creation did not return an id: ${JSON.stringify(response).slice(0, 500)}`);
    }
    return runId;
  }

  async getPendingHitl(runId: string, excludeId?: string): Promise<HitlTask | null> {
    const response = await this.request<unknown>(`/tasks/runs/${runId}/hitltasks`);
    const tasks = Array.isArray(response)
      ? response
      : typeof response === "object" && response !== null && "hitltasks" in response
        ? (response as { hitltasks?: unknown }).hitltasks
        : [];

    if (!Array.isArray(tasks)) return null;
    return (tasks as HitlTask[]).find((task) => task.status === "pending" && task.id !== excludeId) ?? null;
  }

  async submitHitl(runId: string, taskId: string, responseData: Record<string, unknown>): Promise<void> {
    await this.request(`/tasks/runs/${runId}/hitltasks`, {
      method: "POST",
      body: JSON.stringify({
        hitltasks: [
          {
            id: taskId,
            status: "completed",
            response: responseData
          }
        ]
      })
    });
  }

  private async waitForPendingHitl(runId: string, excludeId?: string): Promise<HitlTask> {
    const deadline = Date.now() + this.config.bodhiTimeoutMs;
    while (Date.now() < deadline) {
      const task = await this.getPendingHitl(runId, excludeId);
      if (task) return task;
      await sleep(this.config.bodhiHitlPollIntervalMs);
    }
    throw new Error(`Timed out waiting for pending Bodhi HITL task for run ${runId}`);
  }

  private async waitForCompletion(runId: string): Promise<BodhiRun> {
    const deadline = Date.now() + this.config.bodhiTimeoutMs;
    let lastRun: BodhiRun | undefined;

    while (Date.now() < deadline) {
      lastRun = await this.request<BodhiRun>(`/tasks/${this.config.bodhiTaskId}/runs/${runId}`, {
        timeoutMs: 120000
      });

      const status = String(lastRun.status ?? "unknown").toLowerCase();
      if (FINAL_STATUSES.has(status)) return lastRun;
      await sleep(this.config.bodhiRunPollIntervalMs);
    }

    throw new Error(`Timed out waiting for Bodhi run ${runId} to complete. Last response: ${JSON.stringify(lastRun).slice(0, 500)}`);
  }

  private toDeploymentHitlResponse(request: DeployRequest): Record<string, unknown> {
    return {
      app_name: request.app_name,
      github_repo: request.github_repo,
      github_branch: request.github_branch,
      aws_account_id: request.aws_account_id,
      aws_account_alias: request.aws_account_alias,
      aws_region: request.aws_region,
      cluster_name: request.cluster_name,
      namespace: request.namespace,
      environment: request.environment,
      budget_limit_usd: request.budget_limit_usd,
      confirm_deploy: request.confirm_deploy,
      user_query: `Build and deploy ${request.app_name} Hello World application to EKS cluster ${request.cluster_name} in ${request.aws_region}.`
    };
  }

  private normalizeResult(runId: string, run: BodhiRun, request: DeployRequest): DeploymentResult {
    const payload = firstObject(run.result, run.output, run.outputs, run);

    return {
      status: String(run.status ?? "unknown"),
      run_id: runId,
      application_url: stringValue(payload, "application_url", "app_url", "url"),
      cluster_name: stringValue(payload, "cluster_name") ?? request.cluster_name,
      namespace: stringValue(payload, "namespace") ?? request.namespace,
      aws_region: stringValue(payload, "aws_region", "region") ?? request.aws_region,
      ecr_repository: stringValue(payload, "ecr_repository", "ecr_repo"),
      load_balancer: stringValue(payload, "load_balancer", "load_balancer_dns", "alb_dns_name"),
      stack_names: stringArrayValue(payload, "stack_names", "stacks"),
      estimated_monthly_cost_usd: numberValue(payload, "estimated_monthly_cost_usd", "estimated_cost_usd", "monthly_cost_usd"),
      logs_summary: stringValue(payload, "logs_summary", "summary"),
      raw_bodhi_result: run
    };
  }

  private async request<T>(path: string, options: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
    const url = `${this.config.bodhiApiBaseUrl}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 60000);

    try {
      const response = await this.fetchImpl(url, {
        ...options,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.config.bodhiPatToken}`,
          "Content-Type": "application/json",
          ...options.headers
        }
      });

      const text = await response.text();
      const data = text ? JSON.parse(text) : {};

      if (!response.ok) {
        throw new Error(`Bodhi API ${response.status} ${response.statusText}: ${text.slice(0, 1000)}`);
      }

      return data as T;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function firstObject(...values: unknown[]): Record<string, unknown> {
  for (const value of values) {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    if (typeof value === "string") {
      try {
        const parsed = JSON.parse(value);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // Ignore non-JSON strings; raw output is preserved in raw_bodhi_result.
      }
    }
  }
  return {};
}

function stringValue(payload: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

function numberValue(payload: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  }
  return undefined;
}

function stringArrayValue(payload: Record<string, unknown>, ...keys: string[]): string[] | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
    if (typeof value === "string" && value.trim() !== "") return [value];
  }
  return undefined;
}
