import type { Config } from "./config.js";
import type { ArtifactStatusRequest, DeploymentResult, DeploymentStatusRequest, DeployRequest, ExecuteDeploymentRequest } from "./schemas.js";
import { parseArtifactBundle, validateArtifactBundle, type ArtifactBundle, type ValidatedArtifactBundle } from "./artifacts.js";
import { DeploymentExecutor, type ExecutorResult } from "./deploymentExecutor.js";
import { deriveStackName } from "./naming.js";
import { sanitizeBodhiRun } from "./sanitize.js";

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

type StoredDeployment = {
  runId: string;
  request: DeployRequest;
  requestKey: string;
  createdAt: number;
  submittedHitlIds: Set<string>;
  executionState?: string;
  executionResult?: DeploymentResult;
};

const FINAL_STATUSES = new Set(["completed", "finished", "done", "failed", "error"]);

export class BodhiClient {
  private readonly config: Config;
  private readonly fetchImpl: Fetch;
  private readonly executor: Pick<DeploymentExecutor, "execute">;
  private readonly deploymentsByRunId = new Map<string, StoredDeployment>();
  private readonly runIdByRequestKey = new Map<string, { runId: string; expiresAt: number }>();
  private readonly executionResultsByRunId = new Map<string, DeploymentResult>();

  constructor(config: Config, fetchImpl: Fetch = fetch, executor: Pick<DeploymentExecutor, "execute"> = new DeploymentExecutor(config)) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.executor = executor;
  }

  async deployHelloWorld(request: DeployRequest): Promise<DeploymentResult> {
    return this.startHelloWorldDeployment(request);
  }

  async startHelloWorldDeployment(request: DeployRequest): Promise<DeploymentResult> {
    this.cleanupJobs();
    const stackName = deriveStackName(request.app_name, request.environment);

    if (!request.confirm_deploy) {
      return {
        status: "cancelled",
        run_id: "not-created",
        app_name: request.app_name,
        stack_name: stackName,
        cluster_name: request.cluster_name,
        namespace: request.namespace,
        aws_region: request.aws_region,
        logs_summary: "Bodhi workflow was not started because confirm_deploy was false.",
        next_steps: ["Set confirm_deploy=true when you are ready to generate deployment artifacts."]
      };
    }

    const requestKey = deploymentRequestKey(request);
    const existing = this.runIdByRequestKey.get(requestKey);
    const existingJob = existing && existing.expiresAt > Date.now() ? this.deploymentsByRunId.get(existing.runId) : undefined;
    if (existingJob) {
      return this.startedResult(existingJob.runId, request, "A matching artifact-generation request is already in progress; reusing the existing Bodhi run.");
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

    return this.startedResult(runId, request, "Bodhi artifact-generation workflow started and HITL deployment context was submitted.");
  }

  async getArtifactStatus(input: ArtifactStatusRequest): Promise<DeploymentResult> {
    this.cleanupJobs();
    const runId = input.run_id;
    const job = this.deploymentsByRunId.get(runId);
    const run = await this.getRun(runId);
    const status = String(run.status ?? "unknown").toLowerCase();
    const request = job?.request ?? defaultDeployRequest();
    const stackName = deriveStackName(request.app_name, request.environment);

    if (!FINAL_STATUSES.has(status)) {
      return {
        status,
        run_id: runId,
        app_name: request.app_name,
        stack_name: stackName,
        cluster_name: request.cluster_name,
        namespace: request.namespace,
        aws_region: request.aws_region,
        logs_summary: `Bodhi run ${runId} is ${status}.`,
        next_steps: ["Call get_hello_world_eks_artifact_status again after the workflow finishes."],
        bodhi_run: sanitizeBodhiRun(run)
      };
    }

    const artifactBundle = parseArtifactBundle(run);
    if (!artifactBundle) {
      return {
        status: "artifacts_missing",
        run_id: runId,
        app_name: request.app_name,
        stack_name: stackName,
        cluster_name: request.cluster_name,
        namespace: request.namespace,
        aws_region: request.aws_region,
        logs_summary: "Bodhi completed but did not return a valid deployment_artifacts JSON bundle.",
        next_steps: ["Upload the latest workflow JSON to Bodhi Studio and rerun the artifact generation."],
        bodhi_run: sanitizeBodhiRun(run)
      };
    }

    const validated = validateArtifactBundle(artifactBundle);
    return this.artifactReadyResult(runId, run, request, artifactBundle, validated);
  }

  async getDeploymentStatus(input: DeploymentStatusRequest): Promise<DeploymentResult> {
    return this.getArtifactStatus(input);
  }

  async executeHelloWorldDeployment(input: ExecuteDeploymentRequest): Promise<DeploymentResult> {
    this.cleanupJobs();
    const job = this.deploymentsByRunId.get(input.run_id);
    const cached = this.executionResultsByRunId.get(input.run_id);
    if (cached && !input.force_retry) return cached;
    if (job?.executionResult && !input.force_retry) return job.executionResult;
    if (!input.confirm_execute) {
      return {
        status: "execution_refused",
        run_id: input.run_id,
        stack_name: job ? deriveStackName(job.request.app_name, job.request.environment) : undefined,
        logs_summary: "Execution was refused because confirm_execute was not true.",
        next_steps: ["Call execute_hello_world_eks_deployment with confirm_execute=true only when you intend to create or update AWS infrastructure."]
      };
    }

    const run = await this.getRun(input.run_id);
    const status = String(run.status ?? "unknown").toLowerCase();
    if (!FINAL_STATUSES.has(status)) {
      return {
        status: "artifacts_not_ready",
        run_id: input.run_id,
        logs_summary: `Bodhi run ${input.run_id} is ${status}; deployment artifacts are not ready.`,
        next_steps: ["Call get_hello_world_eks_artifact_status until status is artifacts_ready."]
      };
    }

    const request = job?.request ?? defaultDeployRequest();
    const artifactBundle = parseArtifactBundle(run);
    if (!artifactBundle) {
      return {
        status: "artifacts_missing",
        run_id: input.run_id,
        stack_name: deriveStackName(request.app_name, request.environment),
        logs_summary: "Bodhi completed but did not return deployment_artifacts, so execution cannot proceed.",
        bodhi_run: sanitizeBodhiRun(run)
      };
    }

    const validated = validateArtifactBundle(artifactBundle);
    const mismatch = metadataMismatch(validated, request);
    if (mismatch) {
      const failure: DeploymentResult = {
        status: "failed",
        executor_status: "failed",
        run_id: input.run_id,
        app_name: request.app_name,
        stack_name: deriveStackName(request.app_name, request.environment),
        cluster_name: request.cluster_name,
        namespace: request.namespace,
        aws_region: request.aws_region,
        failure_stage: "artifact_validation",
        root_cause: mismatch,
        remediation: ["Regenerate artifacts with the requested app_name/environment, or start a new deployment request matching the artifact metadata."]
      };
      if (job) job.executionResult = failure;
      return failure;
    }

    if (job) job.executionState = "sam_deploy_started";
    const executorResult = await this.executor.execute(validated, request);
    const result = this.executionResult(input.run_id, artifactBundle, executorResult);
    if (job) {
      job.executionState = result.status === "deployed" ? "rollout_complete" : "failed";
      job.executionResult = result;
    }
    this.executionResultsByRunId.set(input.run_id, result);
    return result;
  }

  async createRun(request: DeployRequest): Promise<string> {
    const response = await this.request<BodhiRun>(`/tasks/${this.config.bodhiTaskId}/runs`, {
      method: "POST",
      body: JSON.stringify({
        runName: `MCP EKS artifacts - ${request.app_name} - ${new Date().toISOString()}`,
        overrides: {
          workflow: this.config.bodhiWorkflowId
        }
      })
    });

    const runId = response.id ?? response.runId;
    if (!runId) throw new Error(`Bodhi run creation did not return an id: ${JSON.stringify(response).slice(0, 500)}`);
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
        hitltasks: [{ id: taskId, status: "completed", response: responseData }]
      })
    });
  }

  async getRun(runId: string): Promise<BodhiRun> {
    return this.request<BodhiRun>(`/tasks/${this.config.bodhiTaskId}/runs/${runId}`, { timeoutMs: 120000 });
  }

  private startedResult(runId: string, request: DeployRequest, logsSummary: string): DeploymentResult {
    return {
      status: "started",
      run_id: runId,
      app_name: request.app_name,
      stack_name: deriveStackName(request.app_name, request.environment),
      cluster_name: request.cluster_name,
      namespace: request.namespace,
      aws_region: request.aws_region,
      logs_summary: logsSummary,
      next_steps: [
        `Call get_hello_world_eks_artifact_status with run_id ${runId}.`,
        "When artifacts are ready, call execute_hello_world_eks_deployment with confirm_execute=true to create or update AWS infrastructure."
      ]
    };
  }

  private artifactReadyResult(runId: string, run: BodhiRun, request: DeployRequest, artifactBundle: ArtifactBundle, validated: ValidatedArtifactBundle): DeploymentResult {
    const stackName = deriveStackName(request.app_name, request.environment);
    return {
      status: "artifacts_ready",
      run_id: runId,
      app_name: request.app_name,
      stack_name: stackName,
      cluster_name: request.cluster_name,
      namespace: request.namespace,
      aws_region: request.aws_region,
      artifact_filenames: validated.deployment_artifacts.map((artifact) => artifact.filename),
      deployment_plan: artifactBundle.deployment_plan,
      cost_notes: artifactBundle.cost_notes,
      security_notes: artifactBundle.security_notes,
      estimated_monthly_cost_usd: numberValue({ estimated_monthly_cost_usd: artifactBundle.estimated_monthly_cost_usd }, "estimated_monthly_cost_usd"),
      next_steps: ["Call execute_hello_world_eks_deployment with confirm_execute=true to create or update AWS infrastructure."],
      infra_details: {
        expected_stack_name: stackName,
        artifact_stack_name: stringValue(validated.metadata, "stack_name"),
        cluster_name: request.cluster_name,
        namespace: request.namespace,
        aws_region: request.aws_region
      },
      bodhi_run: sanitizeBodhiRun(run)
    };
  }

  private executionResult(runId: string, artifactBundle: ArtifactBundle, executorResult: ExecutorResult): DeploymentResult {
    return {
      status: executorResult.status,
      executor_status: executorResult.executor_status,
      run_id: runId,
      app_name: executorResult.app_name,
      stack_name: executorResult.stack_name,
      cloudformation_status: executorResult.cloudformation_status,
      cluster_name: executorResult.cluster_name,
      namespace: executorResult.namespace,
      aws_region: executorResult.aws_region,
      image_mode: executorResult.image_mode,
      service_hostname: executorResult.service_hostname,
      application_url: executorResult.application_url,
      failure_stage: executorResult.failure_stage,
      root_cause: executorResult.root_cause,
      remediation: executorResult.remediation,
      failed_command: executorResult.failed_command,
      logs_summary: executorResult.logs_summary,
      deployment_plan: artifactBundle.deployment_plan,
      cost_notes: artifactBundle.cost_notes,
      security_notes: artifactBundle.security_notes,
      infra_details: executorResult.infra_details,
      executor_logs: executorResult.commands.map((command) => ({
        command: command.command,
        exitCode: command.exitCode,
        stdout: command.stdout.slice(0, 2000),
        stderr: command.stderr.slice(0, 2000)
      }))
    };
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
      stack_name: deriveStackName(request.app_name, request.environment),
      user_query: `Generate deployment artifacts for ${request.app_name} on EKS cluster ${request.cluster_name} in ${request.aws_region}. Expected stack name: ${deriveStackName(request.app_name, request.environment)}.\n\nDeployment context:\n${request.deployment_context}`
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

      if (!response.ok) throw new Error(`Bodhi API ${response.status} ${response.statusText}: ${text.slice(0, 1000)}`);
      return data as T;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function metadataMismatch(bundle: ValidatedArtifactBundle, request: DeployRequest): string | undefined {
  const expectedStackName = deriveStackName(request.app_name, request.environment);
  const artifactStackName = stringValue(bundle.metadata, "stack_name");
  if (artifactStackName && artifactStackName !== expectedStackName) {
    return `Artifact stack_name ${artifactStackName} does not match expected stack_name ${expectedStackName}.`;
  }
  const artifactAppName = stringValue(bundle.metadata, "app_name");
  if (artifactAppName && artifactAppName !== request.app_name) return `Artifact app_name ${artifactAppName} does not match requested app_name ${request.app_name}.`;
  return undefined;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
