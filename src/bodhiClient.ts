import type { Config } from "./config.js";
import type { DeploymentStatusRequest, DeployRequest, DeploymentResult } from "./schemas.js";
import { parseArtifactBundle, validateArtifactBundle } from "./artifacts.js";
import { DeploymentExecutor } from "./deploymentExecutor.js";

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
const TERMINAL_RESULT_STATUSES = new Set(["cancelled", "deployed", "failed", "error", "artifacts_missing"]);

type StoredDeployment = {
  runId: string;
  request: DeployRequest;
  requestKey: string;
  createdAt: number;
  submittedHitlIds: Set<string>;
  finalResult?: DeploymentResult;
};

export class BodhiClient {
  private readonly config: Config;
  private readonly fetchImpl: Fetch;
  private readonly executor: Pick<DeploymentExecutor, "execute">;
  private readonly deploymentsByRunId = new Map<string, StoredDeployment>();
  private readonly runIdByRequestKey = new Map<string, { runId: string; expiresAt: number }>();

  constructor(config: Config, fetchImpl: Fetch = fetch, executor: Pick<DeploymentExecutor, "execute"> = new DeploymentExecutor(config)) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.executor = executor;
  }

  async deployHelloWorld(request: DeployRequest): Promise<DeploymentResult> {
    const started = await this.startHelloWorldDeployment(request);
    if (TERMINAL_RESULT_STATUSES.has(started.status)) return started;

    const deadline = Date.now() + this.config.bodhiTimeoutMs;
    while (Date.now() < deadline) {
      const current = await this.getDeploymentStatus({ run_id: started.run_id });
      if (TERMINAL_RESULT_STATUSES.has(current.status) || FINAL_STATUSES.has(current.status.toLowerCase())) {
        return current;
      }
      await sleep(this.config.bodhiRunPollIntervalMs);
    }

    throw new Error(`Timed out waiting for Bodhi run ${started.run_id} to complete.`);
  }

  async startHelloWorldDeployment(request: DeployRequest): Promise<DeploymentResult> {
    this.cleanupJobs();

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

    const requestKey = deploymentRequestKey(request);
    const existing = this.runIdByRequestKey.get(requestKey);
    const existingJob = existing && existing.expiresAt > Date.now() ? this.deploymentsByRunId.get(existing.runId) : undefined;
    if (existingJob) {
      return existingJob.finalResult ?? this.startedResult(existingJob.runId, request, "A matching deployment request is already in progress; reusing the existing Bodhi run.");
    }

    const runId = await this.createRun(request);
    const job: StoredDeployment = {
      runId,
      request,
      requestKey,
      createdAt: Date.now(),
      submittedHitlIds: new Set()
    };
    this.deploymentsByRunId.set(runId, job);
    this.runIdByRequestKey.set(requestKey, {
      runId,
      expiresAt: Date.now() + this.config.requestDedupTtlMs
    });

    const firstHitl = await this.waitForPendingHitl(runId, undefined, this.config.bodhiStartTimeoutMs);
    await this.submitHitl(runId, firstHitl.id, this.toDeploymentHitlResponse(request));
    job.submittedHitlIds.add(firstHitl.id);

    return this.startedResult(runId, request, "Bodhi workflow started and deployment context HITL input was submitted. Use get_hello_world_eks_deployment_status with this run_id to check completion and run approved artifacts.");
  }

  async getDeploymentStatus(input: DeploymentStatusRequest): Promise<DeploymentResult> {
    this.cleanupJobs();

    const runId = input.run_id;
    const job = this.deploymentsByRunId.get(runId);
    if (job?.finalResult) return job.finalResult;

    if (job) {
      await this.completePendingFollowupHitl(job);
    }

    const run = await this.getRun(runId);
    const status = String(run.status ?? "unknown").toLowerCase();
    if (!FINAL_STATUSES.has(status)) {
      return {
        status,
        run_id: runId,
        cluster_name: job?.request.cluster_name,
        namespace: job?.request.namespace,
        aws_region: job?.request.aws_region,
        logs_summary: `Bodhi run ${runId} is ${status}.`,
        next_steps: ["Call get_hello_world_eks_deployment_status again after the workflow finishes."],
        raw_bodhi_result: run
      };
    }

    const request = job?.request ?? defaultDeployRequest();
    const result = await this.normalizeResult(runId, run, request);
    if (job) job.finalResult = result;
    return result;
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

  async getRun(runId: string): Promise<BodhiRun> {
    return this.request<BodhiRun>(`/tasks/${this.config.bodhiTaskId}/runs/${runId}`, {
      timeoutMs: 120000
    });
  }

  private async waitForPendingHitl(runId: string, excludeId?: string, timeoutMs = this.config.bodhiTimeoutMs): Promise<HitlTask> {
    const deadline = Date.now() + timeoutMs;
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
      lastRun = await this.getRun(runId);

      const status = String(lastRun.status ?? "unknown").toLowerCase();
      if (FINAL_STATUSES.has(status)) return lastRun;
      await sleep(this.config.bodhiRunPollIntervalMs);
    }

    throw new Error(`Timed out waiting for Bodhi run ${runId} to complete. Last response: ${JSON.stringify(lastRun).slice(0, 500)}`);
  }

  private toDeploymentHitlResponse(request: DeployRequest): Record<string, unknown> {
    return {
      deployment_context: request.deployment_context,
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
      user_query: `Build and deploy ${request.app_name} Hello World application to EKS cluster ${request.cluster_name} in ${request.aws_region}.\n\nDeployment context:\n${request.deployment_context}`
    };
  }

  private async completePendingFollowupHitl(job: StoredDeployment): Promise<void> {
    const task = await this.getPendingHitl(job.runId);
    if (!task || job.submittedHitlIds.has(task.id)) return;

    await this.submitHitl(job.runId, task.id, {
      Confirmation: "Yes",
      confirm_deploy: job.request.confirm_deploy,
      deployment_context: job.request.deployment_context
    });
    job.submittedHitlIds.add(task.id);
  }

  private startedResult(runId: string, request: DeployRequest, logsSummary: string): DeploymentResult {
    return {
      status: "started",
      run_id: runId,
      cluster_name: request.cluster_name,
      namespace: request.namespace,
      aws_region: request.aws_region,
      logs_summary: logsSummary,
      next_steps: [
        `Call get_hello_world_eks_deployment_status with run_id ${runId}.`,
        "When Bodhi returns strict deployment_artifacts JSON, the MCP executor will validate and run the approved AWS/SAM/kubectl commands."
      ],
      raw_bodhi_result: {
        run_id: runId,
        started: true
      }
    };
  }

  private cleanupJobs(): void {
    const now = Date.now();
    for (const [key, value] of this.runIdByRequestKey.entries()) {
      if (value.expiresAt <= now) this.runIdByRequestKey.delete(key);
    }
    for (const [runId, job] of this.deploymentsByRunId.entries()) {
      if (job.createdAt + this.config.jobRetentionMs <= now) {
        this.deploymentsByRunId.delete(runId);
        const mapped = this.runIdByRequestKey.get(job.requestKey);
        if (mapped?.runId === runId) this.runIdByRequestKey.delete(job.requestKey);
      }
    }
  }

  private async normalizeResult(runId: string, run: BodhiRun, request: DeployRequest): Promise<DeploymentResult> {
    const payload = firstObject(run.result, run.output, run.outputs, run);
    const artifactBundle = parseArtifactBundle(payload);

    if (artifactBundle) {
      return this.normalizeArtifactResult(runId, run, request, artifactBundle);
    }

    const rawText = firstString(run.result, run.output, run.outputs);
    if (rawText && looksLikeArtifactMarkdown(rawText)) {
      return {
        status: "artifacts_missing",
        run_id: runId,
        cluster_name: request.cluster_name,
        namespace: request.namespace,
        aws_region: request.aws_region,
        logs_summary: "Bodhi completed but returned markdown instead of the required strict JSON deployment_artifacts bundle, so the Railway executor did not run AWS/SAM/kubectl commands.",
        next_steps: [
          "Upload the updated Bodhi workflow JSON that forces strict JSON artifact output.",
          "Rerun deploy_hello_world_to_eks with deployment_context, then poll get_hello_world_eks_deployment_status."
        ],
        raw_bodhi_result: run
      };
    }

    return {
      status: stringValue(payload, "status") ?? String(run.status ?? "unknown"),
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
      next_steps: stringArrayValue(payload, "next_steps"),
      raw_bodhi_result: run
    };
  }

  private async normalizeArtifactResult(runId: string, run: BodhiRun, request: DeployRequest, artifactBundle: NonNullable<ReturnType<typeof parseArtifactBundle>>): Promise<DeploymentResult> {
    const validated = validateArtifactBundle(artifactBundle);
    const executorResult = await this.executor.execute(validated, request);
    const metadata = validated.metadata;

    return {
      status: executorResult.status,
      run_id: runId,
      application_url: executorResult.application_url ?? stringValue(metadata, "application_url", "app_url", "url"),
      cluster_name: stringValue(metadata, "cluster_name") ?? request.cluster_name,
      namespace: stringValue(metadata, "namespace") ?? request.namespace,
      aws_region: stringValue(metadata, "aws_region", "region") ?? request.aws_region,
      ecr_repository: stringValue(metadata, "ecr_repository", "ecr_repo"),
      load_balancer: stringValue(metadata, "load_balancer", "load_balancer_dns", "alb_dns_name"),
      stack_names: stringArrayValue(metadata, "stack_names", "stacks", "stack_name"),
      estimated_monthly_cost_usd: numberValue({ estimated_monthly_cost_usd: artifactBundle.estimated_monthly_cost_usd }, "estimated_monthly_cost_usd"),
      logs_summary: executorResult.logs_summary,
      deployment_plan: artifactBundle.deployment_plan,
      cost_notes: artifactBundle.cost_notes,
      security_notes: artifactBundle.security_notes,
      next_steps: artifactBundle.next_steps,
      executor_status: executorResult.status,
      executor_logs: executorResult.commands,
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

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value;
    if (typeof value === "object" && value !== null) {
      const nested = firstString(
        (value as Record<string, unknown>).response,
        (value as Record<string, unknown>).result,
        (value as Record<string, unknown>).output,
        (value as Record<string, unknown>).text
      );
      if (nested) return nested;
    }
  }
  return undefined;
}

function looksLikeArtifactMarkdown(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    normalized.includes("deployment artifact") ||
    normalized.includes("template.yaml") ||
    normalized.includes("k8s.yaml") ||
    normalized.includes("cloudformation") ||
    normalized.includes("kubectl apply") ||
    normalized.includes("sam deploy")
  );
}

function deploymentRequestKey(request: DeployRequest): string {
  return JSON.stringify({
    deployment_context: request.deployment_context,
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
    confirm_deploy: request.confirm_deploy
  });
}

function defaultDeployRequest(): DeployRequest {
  return {
    deployment_context: "Status lookup for a previously-started Hello World EKS deployment. Original deployment context is not available in this server process.",
    app_name: "hello-world",
    github_repo: "sksachan/cmp_mcp_server_dev",
    github_branch: "main",
    aws_account_id: process.env.AWS_ACCOUNT_ID ?? "051370627449",
    aws_account_alias: process.env.AWS_ACCOUNT_ALIAS ?? "demo",
    aws_region: process.env.DEFAULT_AWS_REGION ?? "us-east-1",
    cluster_name: process.env.DEFAULT_CLUSTER_NAME ?? "hello-world-demo",
    namespace: process.env.DEFAULT_NAMESPACE ?? "hello-world",
    environment: "dev",
    budget_limit_usd: Number(process.env.DEFAULT_BUDGET_LIMIT_USD ?? 100),
    confirm_deploy: true
  };
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
