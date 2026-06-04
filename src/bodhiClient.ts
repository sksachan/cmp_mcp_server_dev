import type { Config } from "./config.js";
import type { ArtifactStatusRequest, DeploymentResult, DeploymentStatusRequest, DeployRequest, ExecuteDeploymentRequest, InfraReportRequest } from "./schemas.js";
import { normalizeNotes, normalizeStringList, parseArtifactBundle, validateArtifactBundle, type ArtifactBundle, type ValidatedArtifactBundle } from "./artifacts.js";
import { DeploymentExecutor, runCommand, type ExecutorResult } from "./deploymentExecutor.js";
import { sanitizeBodhiRun } from "./sanitize.js";
import { buildDevopsReportProjection, InfraReporter } from "./infraReporter.js";
import { completeIdentity, identityFromRequest, validateDeploymentIdentity, type DeploymentIdentity, type IdentityValidationResult } from "./deploymentIdentity.js";

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
  identity: DeploymentIdentity;
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
  private readonly reporter: InfraReporter;
  private readonly deploymentsByRunId = new Map<string, StoredDeployment>();
  private readonly runIdByRequestKey = new Map<string, { runId: string; expiresAt: number }>();
  private readonly executionResultsByRunId = new Map<string, DeploymentResult>();

  constructor(config: Config, fetchImpl: Fetch = fetch, executor: Pick<DeploymentExecutor, "execute"> = new DeploymentExecutor(config)) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.executor = executor;
    this.reporter = new InfraReporter(runCommand, config.executorCommandTimeoutMs);
  }

  async deployHelloWorld(request: DeployRequest): Promise<DeploymentResult> {
    return this.startHelloWorldDeployment(request);
  }

  async startHelloWorldDeployment(request: DeployRequest): Promise<DeploymentResult> {
    this.cleanupJobs();
    const stackName = request.stack_name;

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
      identity: identityFromRequest(request),
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
    const request = job?.request;
    const requestIdentity = job?.identity;

    if (!FINAL_STATUSES.has(status)) {
      return {
        status,
        run_id: runId,
        app_name: request?.app_name,
        stack_name: request?.stack_name,
        cluster_name: request?.cluster_name,
        namespace: request?.namespace,
        aws_region: request?.aws_region,
        request_identity_available: Boolean(requestIdentity),
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
        app_name: request?.app_name,
        stack_name: request?.stack_name,
        cluster_name: request?.cluster_name,
        namespace: request?.namespace,
        aws_region: request?.aws_region,
        request_identity_available: Boolean(requestIdentity),
        logs_summary: "Bodhi completed but did not return a valid deployment_artifacts JSON bundle.",
        next_steps: ["Upload the latest workflow JSON to Bodhi Studio and rerun the artifact generation."],
        bodhi_run: sanitizeBodhiRun(run)
      };
    }

    const validated = validateArtifactBundle(artifactBundle);
    const identityValidation = validateDeploymentIdentity({ artifactBundle, validatedBundle: validated, requestIdentity });
    if (identityValidation.mismatches.length > 0) {
      return this.identityMismatchResult(runId, requestIdentity, identityValidation, artifactBundle, validated, run);
    }
    return this.artifactReadyResult(runId, run, request, artifactBundle, validated, identityValidation);
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
        stack_name: job?.identity.stack_name,
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

    const request = job?.request ?? requestFromIdentityConfirmation(input.identity_confirmation);
    const requestIdentity = job?.identity ?? completeIdentity(input.identity_confirmation);
    if (!request || !requestIdentity) {
      return {
        status: "identity_confirmation_required",
        executor_status: "failed",
        run_id: input.run_id,
        failure_stage: "artifact_identity_mismatch",
        root_cause: "Stored MCP request identity is unavailable for this run. Execution requires explicit identity_confirmation.",
        request_identity_available: false,
        executor_logs: [],
        next_steps: ["Call execute_hello_world_eks_deployment again with identity_confirmation matching the completed artifact bundle."]
      };
    }
    const artifactBundle = parseArtifactBundle(run);
    if (!artifactBundle) {
      return {
        status: "artifacts_missing",
        run_id: input.run_id,
        stack_name: request.stack_name,
        logs_summary: "Bodhi completed but did not return deployment_artifacts, so execution cannot proceed.",
        bodhi_run: sanitizeBodhiRun(run)
      };
    }

    const validated = validateArtifactBundle(artifactBundle);
    const identityValidation = validateDeploymentIdentity({ artifactBundle, validatedBundle: validated, requestIdentity, identityConfirmation: input.identity_confirmation });
    if (!identityValidation.ok) {
      const failure = this.identityMismatchResult(input.run_id, requestIdentity, identityValidation, artifactBundle, validated, run);
      if (job) job.executionResult = failure;
      return failure;
    }

    if (job) job.executionState = "sam_deploy_started";
    const executorResult = await this.executor.execute(validated, request, { updateExisting: input.update_existing });
    const result = this.executionResult(input.run_id, artifactBundle, executorResult);
    if (job) {
      job.executionState = result.status === "deployed" ? "rollout_complete" : "failed";
      job.executionResult = result;
    }
    this.executionResultsByRunId.set(input.run_id, result);
    return result;
  }

  async getInfraReport(input: InfraReportRequest): Promise<DeploymentResult> {
    const report = await this.reporter.buildReport({
      stackName: input.stack_name,
      region: input.aws_region,
      appName: input.app_name ?? "hello-world",
      namespace: input.namespace ?? "hello-world",
      clusterName: input.cluster_name ?? input.stack_name.replace(/-eks$/, ""),
      imageMode: this.config.usePublicHelloWorldImage ? "public_nginx_unprivileged" : undefined
    });
    const projection = buildDevopsReportProjection(report, {
      stackName: input.stack_name,
      region: input.aws_region,
      appName: input.app_name,
      namespace: input.namespace,
      clusterName: input.cluster_name,
      awsAccountId: process.env.AWS_ACCOUNT_ID,
      budgetTargetUsd: Number(process.env.DEFAULT_BUDGET_LIMIT_USD ?? 100)
    });
    const endpoint = projection.application_endpoint as { url?: string | null };
    return {
      status: report.report_warnings?.length ? "report_ready_with_warnings" : "report_ready",
      run_id: "not-applicable",
      message: "Infrastructure report generated.",
      stack_name: input.stack_name,
      aws_region: input.aws_region,
      cluster_name: input.cluster_name,
      namespace: input.namespace,
      app_name: input.app_name,
      application_url: typeof endpoint.url === "string" ? endpoint.url : undefined,
      infra_summary: projection.infra_summary,
      application_endpoint: projection.application_endpoint,
      devops_report: projection.devops_report,
      cleanup: projection.cleanup,
      warnings: projection.warnings,
      cost_estimate: projection.cost_estimate,
      validation_checks: projection.validation_checks,
      resource_inventory: projection.resource_inventory,
      report_warnings: report.report_warnings,
      infra_report: report as unknown as Record<string, unknown>
    };
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
      stack_name: request.stack_name,
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

  private artifactReadyResult(runId: string, run: BodhiRun, request: DeployRequest | undefined, artifactBundle: ArtifactBundle, validated: ValidatedArtifactBundle, identityValidation: IdentityValidationResult): DeploymentResult {
    const identity = identityValidation.canonical_identity;
    return {
      status: "artifacts_ready",
      run_id: runId,
      app_name: identity?.app_name ?? request?.app_name,
      stack_name: identity?.stack_name ?? request?.stack_name,
      cluster_name: identity?.cluster_name ?? request?.cluster_name,
      namespace: identity?.namespace ?? request?.namespace,
      aws_region: identity?.aws_region ?? request?.aws_region,
      canonical_identity: identity,
      request_identity_available: Boolean(request),
      identity_findings: identityValidation.findings as unknown as Record<string, unknown>[],
      identity_mismatches: identityValidation.mismatches as unknown as Record<string, unknown>[],
      identity_warnings: identityValidation.warnings,
      artifact_filenames: validated.deployment_artifacts.map((artifact) => artifact.filename),
      deployment_plan: normalizeStringList(artifactBundle.deployment_plan),
      cost_notes: normalizeNotes(artifactBundle.cost_notes),
      security_notes: normalizeNotes(artifactBundle.security_notes),
      estimated_monthly_cost_usd: numberValue({ estimated_monthly_cost_usd: artifactBundle.estimated_monthly_cost_usd }, "estimated_monthly_cost_usd"),
      next_steps: request
        ? ["Call execute_hello_world_eks_deployment with confirm_execute=true to create or update AWS infrastructure."]
        : ["Stored request identity is unavailable; execution requires identity_confirmation."],
      infra_details: {
        expected_stack_name: request?.stack_name,
        artifact_stack_name: stringValue(validated.metadata, "stack_name"),
        cluster_name: identity?.cluster_name,
        namespace: identity?.namespace,
        aws_region: identity?.aws_region
      },
      bodhi_run: sanitizeBodhiRun(run)
    };
  }

  private executionResult(runId: string, artifactBundle: ArtifactBundle, executorResult: ExecutorResult): DeploymentResult {
    return {
      status: executorResult.status,
      executor_status: executorResult.executor_status,
      run_id: runId,
      message: executorResult.message,
      app_name: executorResult.app_name,
      stack_name: executorResult.stack_name,
      aws_account_id: process.env.AWS_ACCOUNT_ID,
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
      deployment_plan: normalizeStringList(artifactBundle.deployment_plan),
      cost_notes: normalizeNotes(artifactBundle.cost_notes),
      security_notes: normalizeNotes(artifactBundle.security_notes),
      infra_details: executorResult.infra_details,
      infra_summary: executorResult.infra_summary,
      application_endpoint: executorResult.application_endpoint,
      devops_report: executorResult.devops_report,
      cleanup: executorResult.cleanup,
      warnings: executorResult.warnings,
      cost_estimate: executorResult.cost_estimate,
      validation_checks: executorResult.validation_checks,
      resource_inventory: executorResult.resource_inventory,
      report_warnings: executorResult.report_warnings,
      infra_report: executorResult.infra_report as unknown as Record<string, unknown> | undefined,
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
      stack_name: request.stack_name,
      user_query: `Generate deployment artifacts for ${request.app_name} on EKS cluster ${request.cluster_name} in ${request.aws_region}. Expected stack name: ${request.stack_name}.\n\nDeployment context:\n${request.deployment_context}`
    };
  }

  private identityMismatchResult(runId: string, requestIdentity: DeploymentIdentity | undefined, identityValidation: IdentityValidationResult, artifactBundle: ArtifactBundle, validated: ValidatedArtifactBundle, run: BodhiRun): DeploymentResult {
    const artifactIdentity = completeIdentity(identityValidation.findings.find((finding) => finding.source === "params_json")?.identity)
      ?? completeIdentity(identityValidation.findings.find((finding) => finding.source === "infra_details")?.identity)
      ?? completeIdentity(identityValidation.findings.find((finding) => finding.source === "artifact_root")?.identity)
      ?? identityValidation.canonical_identity;
    return {
      status: "artifact_identity_mismatch",
      executor_status: "failed",
      run_id: runId,
      app_name: requestIdentity?.app_name ?? artifactIdentity?.app_name,
      stack_name: requestIdentity?.stack_name ?? artifactIdentity?.stack_name,
      cluster_name: requestIdentity?.cluster_name ?? artifactIdentity?.cluster_name,
      namespace: requestIdentity?.namespace ?? artifactIdentity?.namespace,
      aws_region: requestIdentity?.aws_region ?? artifactIdentity?.aws_region,
      failure_stage: "artifact_identity_mismatch",
      root_cause: requestIdentity
        ? "Bodhi artifact deployment identity does not match the requested MCP run identity."
        : "Stored MCP request identity is unavailable or artifact identity is inconsistent.",
      requested_identity: requestIdentity,
      artifact_identity: artifactIdentity,
      canonical_identity: identityValidation.canonical_identity,
      request_identity_available: Boolean(requestIdentity),
      identity_findings: identityValidation.findings as unknown as Record<string, unknown>[],
      identity_mismatches: identityValidation.mismatches as unknown as Record<string, unknown>[],
      identity_warnings: identityValidation.warnings,
      artifact_filenames: validated.deployment_artifacts.map((artifact) => artifact.filename),
      deployment_plan: normalizeStringList(artifactBundle.deployment_plan),
      cost_notes: normalizeNotes(artifactBundle.cost_notes),
      security_notes: normalizeNotes(artifactBundle.security_notes),
      executor_logs: [],
      next_steps: [
        "Regenerate artifacts with aligned app_name, stack_name, cluster_name, namespace and region.",
        "Do not execute deployment until identity mismatch is resolved."
      ],
      bodhi_run: sanitizeBodhiRun(run)
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

function deploymentRequestKey(request: DeployRequest): string {
  return JSON.stringify({
    deployment_context: request.deployment_context,
    app_name: request.app_name,
    stack_name: request.stack_name,
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

function requestFromIdentityConfirmation(identity: ExecuteDeploymentRequest["identity_confirmation"]): DeployRequest | undefined {
  const complete = completeIdentity(identity);
  if (!complete) return undefined;
  return {
    deployment_context: "Execution request for a historical Bodhi run with explicit identity_confirmation.",
    app_name: complete.app_name,
    stack_name: complete.stack_name,
    github_repo: "sksachan/cmp_mcp_server_dev",
    github_branch: "main",
    aws_account_id: process.env.AWS_ACCOUNT_ID ?? "051370627449",
    aws_account_alias: process.env.AWS_ACCOUNT_ALIAS ?? "demo",
    aws_region: complete.aws_region,
    cluster_name: complete.cluster_name,
    namespace: complete.namespace,
    environment: complete.environment,
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
