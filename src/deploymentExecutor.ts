import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import type { Config } from "./config.js";
import type { DeployRequest } from "./schemas.js";
import type { DeploymentArtifact, ValidatedArtifactBundle } from "./artifacts.js";
import { sanitizeName } from "./naming.js";
import { classifyCommandFailure, rollbackCompleteDiagnostic, type FailureDiagnostic } from "./failureClassifier.js";
import { cleanupCommands, InfraReporter, type InfraReport } from "./infraReporter.js";

export type CommandRunner = (command: string, args: string[], options: { cwd: string; timeoutMs: number; env: NodeJS.ProcessEnv }) => Promise<CommandResult>;

export type CommandResult = {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type ExecutorResult = {
  status: "deployed" | "deployed_pending_endpoint" | "deployed_with_report_warnings" | "failed" | "blocked";
  executor_status: "deployed" | "failed" | "blocked";
  workspace: string;
  commands: CommandResult[];
  logs_summary: string;
  stack_name: string;
  cloudformation_status?: string;
  cluster_name: string;
  namespace: string;
  app_name: string;
  aws_region: string;
  image_mode?: string;
  service_hostname?: string;
  application_url?: string;
  rollout_status?: "success" | "failed";
  infra_details?: Record<string, unknown>;
  infra_report?: InfraReport;
  infra_summary?: Record<string, unknown>;
  cleanup?: Record<string, unknown>;
  report_warnings?: string[];
  message?: string;
} & Partial<FailureDiagnostic>;

const SAFE_STACK_STATUSES = new Set(["CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE"]);

export class DeploymentExecutor {
  private readonly config: Config;
  private readonly runner: CommandRunner;
  private readonly reporter: InfraReporter;

  constructor(config: Config, runner: CommandRunner = runCommand) {
    this.config = config;
    this.runner = runner;
    this.reporter = new InfraReporter(runner, config.executorCommandTimeoutMs);
  }

  async execute(bundle: ValidatedArtifactBundle, request: DeployRequest, options: { updateExisting?: boolean } = {}): Promise<ExecutorResult> {
    const workspace = await this.writeArtifacts(bundle.deployment_artifacts);
    const stackName = stringValue(bundle.metadata.stack_name) ?? request.stack_name;
    const clusterName = stringValue(bundle.metadata.cluster_name) ?? request.cluster_name;
    const namespace = stringValue(bundle.metadata.namespace) ?? request.namespace;
    const region = stringValue(bundle.metadata.aws_region) ?? request.aws_region;
    const appName = stringValue(bundle.metadata.app_name) ?? request.app_name;
    const commands: CommandResult[] = [];
    const env = {
      ...process.env,
      AWS_REGION: region,
      AWS_DEFAULT_REGION: region
    };

    const templatePath = join(workspace, bundle.cloudformationTemplate.filename);
    const manifestPath = bundle.kubernetesManifest ? join(workspace, bundle.kubernetesManifest.filename) : undefined;
    let template = await readFile(templatePath, "utf8");
    const normalized = normalizeCloudFormationTemplate(template);
    if (normalized.changed) {
      template = normalized.content;
      await writeFile(templatePath, template, "utf8");
      commands.push(localSuccess("normalize CloudFormation template", normalized.summary));
    }

    if (template.includes("REPLACEME_OIDC_ID")) {
      const describeCluster = await this.run(commands, "aws", [
        "eks",
        "describe-cluster",
        "--name",
        clusterName,
        "--region",
        region,
        "--query",
        "cluster.identity.oidc.issuer",
        "--output",
        "text"
      ], workspace, env);
      if (describeCluster.exitCode !== 0) return failedResult(baseContext(workspace, commands, stackName, clusterName, namespace, appName, region), classifyCommandFailure(describeCluster, { stackName, region, stage: "eks_describe_cluster" }));

      const oidcId = extractOidcId(describeCluster.stdout);
      if (!oidcId) {
        const failure = localFailure("resolve EKS OIDC provider ID", `Could not extract OIDC provider ID from: ${describeCluster.stdout}`);
        commands.push(failure);
        return failedResult(baseContext(workspace, commands, stackName, clusterName, namespace, appName, region), classifyCommandFailure(failure, { stackName, region, stage: "eks_describe_cluster" }));
      }
      await writeFile(templatePath, template.replaceAll("REPLACEME_OIDC_ID", oidcId), "utf8");
    }

    const validate = await this.run(commands, "sam", ["validate", "--template-file", bundle.cloudformationTemplate.filename, "--region", region], workspace, env);
    if (validate.exitCode !== 0) return failedResult(baseContext(workspace, commands, stackName, clusterName, namespace, appName, region), classifyCommandFailure(validate, { stackName, region, stage: "sam_validate" }));

    const preflight = await this.cloudFormationPreflight(commands, workspace, env, stackName, region, options.updateExisting === true);
    if (preflight.decision !== "proceed") {
      return failedResult(baseContext(workspace, commands, stackName, clusterName, namespace, appName, region, undefined, preflight.stackStatus), preflight.diagnostic, preflight.decision === "blocked" ? "blocked" : "failed");
    }

    const deploy = await this.run(commands, "sam", [
      "deploy",
      "--template-file",
      bundle.cloudformationTemplate.filename,
      "--stack-name",
      stackName,
      "--region",
      region,
      "--capabilities",
      "CAPABILITY_IAM",
      "CAPABILITY_NAMED_IAM",
      "--no-confirm-changeset",
      "--no-fail-on-empty-changeset",
      ...parameterOverrideArgs(bundle.metadata)
    ], workspace, env);
    if (deploy.exitCode !== 0) return failedResult(baseContext(workspace, commands, stackName, clusterName, namespace, appName, region, undefined, preflight.stackStatus), classifyCommandFailure(deploy, { stackName, region, stage: "cloudformation_deploy" }));

    const stack = await this.describeStack(commands, workspace, env, stackName, region);
    if (stack.command.exitCode !== 0) return failedResult(baseContext(workspace, commands, stackName, clusterName, namespace, appName, region), classifyCommandFailure(stack.command, { stackName, region, stage: "cloudformation_outputs" }));

    const outputs = stack.outputs;
    const cloudformationStatus = stack.status;

    if (bundle.kubernetesManifest && manifestPath) {
      try {
        await this.applyPostDeployPatches(bundle, outputs, manifestPath);
        await this.applyLegacyRolePatch(outputs, manifestPath);
      } catch (error) {
        const failure = localFailure("apply post-deploy patches", error instanceof Error ? error.message : String(error));
        commands.push(failure);
        return failedResult(baseContext(workspace, commands, stackName, clusterName, namespace, appName, region, outputs, cloudformationStatus, bundle.metadata), {
          failure_stage: "post_deploy_patches",
          root_cause: failure.stderr,
          remediation: ["Regenerate artifacts with valid post_deploy_patches metadata and matching placeholders, then retry execution."],
          failed_command: failure.command
        });
      }
      let manifest = await readFile(manifestPath, "utf8");
      let imageMode = determineImageMode(manifest);
      if (this.config.usePublicHelloWorldImage && imageMode !== "public_nginx") {
        manifest = applyPublicHelloWorldImageOverride(manifest);
        await writeFile(manifestPath, manifest, "utf8");
        imageMode = "public_nginx_unprivileged";
      }

      const updateKubeconfig = await this.run(commands, "aws", ["eks", "update-kubeconfig", "--name", clusterName, "--region", region], workspace, env);
      if (updateKubeconfig.exitCode !== 0) return failedResult(baseContext(workspace, commands, stackName, clusterName, namespace, appName, region, outputs, cloudformationStatus), classifyCommandFailure(updateKubeconfig, { stackName, region, stage: "eks_update_kubeconfig" }));

      const apply = await this.run(commands, "kubectl", ["apply", "-n", namespace, "-f", bundle.kubernetesManifest.filename], workspace, env);
      if (apply.exitCode !== 0) return failedResult(baseContext(workspace, commands, stackName, clusterName, namespace, appName, region, outputs, cloudformationStatus), classifyCommandFailure(apply, { stackName, region, stage: "kubectl_apply" }));

      const deploymentName = extractKubernetesName(manifest, "Deployment") ?? sanitizeName(appName);
      const serviceName = extractKubernetesName(manifest, "Service") ?? `${sanitizeName(appName)}-svc`;

      const rollout = await this.run(commands, "kubectl", ["rollout", "status", `deployment/${deploymentName}`, "-n", namespace, "--timeout=10m"], workspace, env);
      if (rollout.exitCode !== 0) return failedResult(baseContext(workspace, commands, stackName, clusterName, namespace, appName, region, outputs, cloudformationStatus), classifyCommandFailure(rollout, { stackName, region, stage: "kubernetes_rollout" }));

      await this.run(commands, "kubectl", ["get", "pods", "-n", namespace, "-o", "wide"], workspace, env);
      await this.run(commands, "kubectl", ["get", "svc", serviceName, "-n", namespace, "-o", "json"], workspace, env);
      const hostname = await this.run(commands, "kubectl", ["get", "svc", serviceName, "-n", namespace, "-o", "jsonpath={.status.loadBalancer.ingress[0].hostname}"], workspace, env);
      const serviceHostname = hostname.exitCode === 0 && hostname.stdout.trim() ? hostname.stdout.trim() : undefined;
      const context = baseContext(workspace, commands, stackName, clusterName, namespace, appName, region, outputs, cloudformationStatus, bundle.metadata);

      if (!serviceHostname) {
        const base = {
          ...context,
          status: "deployed_pending_endpoint",
          executor_status: "deployed",
          image_mode: imageMode,
          rollout_status: "success",
          root_cause: "LoadBalancer hostname not yet assigned.",
          remediation: [
            "Retry status in 2-3 minutes.",
            `kubectl get svc ${serviceName} -n ${namespace}`
          ]
        } satisfies ExecutorResult;
        return this.withInfraReport(base, stackName, region, appName, namespace, clusterName, base.image_mode);
      }

      const base = {
        ...context,
        status: "deployed",
        executor_status: "deployed",
        image_mode: imageMode,
        rollout_status: "success",
        service_hostname: serviceHostname,
        application_url: `http://${serviceHostname}`,
        message: "Deployment completed and infrastructure report generated."
      } satisfies ExecutorResult;
      return this.withInfraReport(base, stackName, region, appName, namespace, clusterName, base.image_mode);
    }

    const base = {
      ...baseContext(workspace, commands, stackName, clusterName, namespace, appName, region, outputs, cloudformationStatus, bundle.metadata),
      status: "deployed",
      executor_status: "deployed",
      message: "Deployment completed and infrastructure report generated."
    } satisfies ExecutorResult;
    return this.withInfraReport(base, stackName, region, appName, namespace, clusterName);
  }

  buildCommandPlan(bundle: ValidatedArtifactBundle, request: DeployRequest): Array<{ command: string; args: string[] }> {
    const stackName = stringValue(bundle.metadata.stack_name) ?? request.stack_name;
    const clusterName = stringValue(bundle.metadata.cluster_name) ?? request.cluster_name;
    const namespace = stringValue(bundle.metadata.namespace) ?? request.namespace;
    const region = stringValue(bundle.metadata.aws_region) ?? request.aws_region;
    const plan = [
      { command: "sam", args: ["validate", "--template-file", bundle.cloudformationTemplate.filename, "--region", region] },
      { command: "aws", args: ["cloudformation", "describe-stacks", "--stack-name", stackName, "--region", region, "--query", "Stacks[0].StackStatus", "--output", "text"] },
      {
        command: "sam",
        args: [
          "deploy",
          "--template-file",
          bundle.cloudformationTemplate.filename,
          "--stack-name",
          stackName,
          "--region",
          region,
          "--capabilities",
          "CAPABILITY_IAM",
          "CAPABILITY_NAMED_IAM",
          "--no-confirm-changeset",
          "--no-fail-on-empty-changeset",
          ...parameterOverrideArgs(bundle.metadata)
        ]
      },
      { command: "aws", args: ["cloudformation", "describe-stacks", "--stack-name", stackName, "--region", region, "--query", "Stacks[0]", "--output", "json"] }
    ];

    if (bundle.kubernetesManifest) {
      plan.push(
        { command: "aws", args: ["eks", "update-kubeconfig", "--name", clusterName, "--region", region] },
        { command: "kubectl", args: ["apply", "-n", namespace, "-f", bundle.kubernetesManifest.filename] },
        { command: "kubectl", args: ["rollout", "status", `deployment/${sanitizeName(request.app_name)}`, "-n", namespace, "--timeout=10m"] },
        { command: "kubectl", args: ["get", "pods", "-n", namespace, "-o", "wide"] }
      );
    }

    return plan;
  }

  private async run(commands: CommandResult[], command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<CommandResult> {
    const result = await this.runner(command, args, {
      cwd,
      timeoutMs: this.config.executorCommandTimeoutMs,
      env
    });
    commands.push(result);
    return result;
  }

  private async cloudFormationPreflight(commands: CommandResult[], workspace: string, env: NodeJS.ProcessEnv, stackName: string, region: string, updateExisting: boolean): Promise<{ decision: "proceed" | "failed" | "blocked"; stackStatus?: string; diagnostic?: FailureDiagnostic }> {
    const result = await this.run(commands, "aws", ["cloudformation", "describe-stacks", "--stack-name", stackName, "--region", region, "--query", "Stacks[0].StackStatus", "--output", "text"], workspace, env);
    const output = `${result.stdout}\n${result.stderr}`;
    if (result.exitCode !== 0) {
      if (/does not exist|validationerror/i.test(output)) return { decision: "proceed" };
      return { decision: "failed", diagnostic: classifyCommandFailure(result, { stackName, region, stage: "cloudformation_preflight" }) };
    }

    const stackStatus = result.stdout.trim();
    if (stackStatus === "ROLLBACK_COMPLETE") {
      return { decision: "failed", stackStatus, diagnostic: rollbackCompleteDiagnostic(stackName, region) };
    }
    if (stackStatus.endsWith("_IN_PROGRESS") || stackStatus === "DELETE_IN_PROGRESS") {
      return {
        decision: "blocked",
        stackStatus,
        diagnostic: {
          failure_stage: "cloudformation_preflight",
          root_cause: `CloudFormation stack ${stackName} is currently ${stackStatus}.`,
          remediation: [`Wait until stack ${stackName} leaves ${stackStatus}, then retry execution.`],
          failed_command: result.command
        }
      };
    }
    if (!SAFE_STACK_STATUSES.has(stackStatus)) {
      return {
        decision: "failed",
        stackStatus,
        diagnostic: {
          failure_stage: "cloudformation_preflight",
          root_cause: `CloudFormation stack ${stackName} is in unsupported state ${stackStatus}.`,
          remediation: ["Delete or repair the stack, or use a new app_name/stack_name."],
          failed_command: result.command
        }
      };
    }
    if (!updateExisting) {
      return {
        decision: "failed",
        stackStatus,
        diagnostic: {
          failure_stage: "cloudformation_preflight",
          root_cause: `CloudFormation stack ${stackName} already exists in ${stackStatus}.`,
          remediation: ["Set update_existing=true only if this stack belongs to the same deployment identity, or use a new stack_name."],
          failed_command: result.command
        }
      };
    }
    return { decision: "proceed", stackStatus };
  }

  private async describeStack(commands: CommandResult[], workspace: string, env: NodeJS.ProcessEnv, stackName: string, region: string): Promise<{ command: CommandResult; outputs: Record<string, string>; status?: string }> {
    const command = await this.run(commands, "aws", ["cloudformation", "describe-stacks", "--stack-name", stackName, "--region", region, "--query", "Stacks[0]", "--output", "json"], workspace, env);
    if (command.exitCode !== 0) return { command, outputs: {} };
    const parsed = JSON.parse(command.stdout);
    const outputs: Record<string, string> = {};
    if (Array.isArray(parsed.Outputs)) {
      for (const output of parsed.Outputs) {
        if (typeof output.OutputKey === "string" && typeof output.OutputValue === "string") outputs[output.OutputKey] = output.OutputValue;
      }
    }
    return { command, outputs, status: typeof parsed.StackStatus === "string" ? parsed.StackStatus : undefined };
  }

  private async applyPostDeployPatches(bundle: ValidatedArtifactBundle, outputs: Record<string, string>, manifestPath: string): Promise<void> {
    const raw = bundle.metadata.post_deploy_patches;
    if (!Array.isArray(raw)) return;
    let manifest = await readFile(manifestPath, "utf8");
    for (const patch of raw) {
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) continue;
      const item = patch as Record<string, unknown>;
      const artifact = stringValue(item.artifact);
      const placeholder = stringValue(item.placeholder);
      const outputKey = stringValue(item.source_cf_output_key);
      const patchType = stringValue(item.patch_type) ?? "string_replace";
      if (artifact !== "k8s.yaml" || !placeholder || !outputKey || patchType !== "string_replace") continue;
      const outputValue = outputs[outputKey];
      if (!outputValue) throw new Error(`CloudFormation output ${outputKey} required for post_deploy_patches was not found.`);
      if (!manifest.includes(placeholder)) throw new Error(`Post-deploy patch placeholder ${placeholder} was not found in k8s.yaml.`);
      manifest = manifest.replaceAll(placeholder, outputValue);
    }
    await writeFile(manifestPath, manifest, "utf8");
  }

  private async applyLegacyRolePatch(outputs: Record<string, string>, manifestPath: string): Promise<void> {
    let manifest = await readFile(manifestPath, "utf8");
    if (!manifest.includes("REPLACEME_POD_ROLE_ARN")) return;
    const roleArn = outputs.PodRoleArn ?? outputs.NodeRoleArn;
    if (!roleArn) throw new Error("k8s.yaml contains REPLACEME_POD_ROLE_ARN but CloudFormation did not output PodRoleArn or NodeRoleArn.");
    manifest = manifest.replaceAll("REPLACEME_POD_ROLE_ARN", roleArn);
    await writeFile(manifestPath, manifest, "utf8");
  }

  private async writeArtifacts(artifacts: DeploymentArtifact[]): Promise<string> {
    const workspace = join(tmpdir(), `cmp-mcp-deploy-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(workspace, { recursive: true });

    for (const artifact of artifacts) {
      await writeFile(join(workspace, artifact.filename), artifact.content, "utf8");
    }

    return workspace;
  }

  private async withInfraReport(base: ExecutorResult, stackName: string, region: string, appName: string, namespace: string, clusterName: string, imageMode?: string): Promise<ExecutorResult> {
    try {
      const infraReport = await this.reporter.buildReport({ stackName, region, appName, namespace, clusterName, imageMode });
      const cost = infraReport.cost_estimate as { monthly_total_estimate?: number };
      const service = infraReport.kubernetes?.service as { hostname?: string } | undefined;
      return {
        ...base,
        status: infraReport.report_warnings?.length ? "deployed_with_report_warnings" : base.status,
        infra_report: infraReport,
        infra_summary: {
          stack_name: base.stack_name,
          cloudformation_status: infraReport.cloudformation?.status ?? base.cloudformation_status,
          cluster_name: base.cluster_name,
          eks_status: (infraReport.eks as { cluster_status?: string }).cluster_status,
          namespace: base.namespace,
          deployment: (infraReport.kubernetes as { deployment_name?: string }).deployment_name,
          service_hostname: service?.hostname ?? base.service_hostname,
          monthly_cost_estimate_usd: cost.monthly_total_estimate
        },
        cleanup: infraReport.cleanup,
        report_warnings: infraReport.report_warnings,
        application_url: base.application_url ?? (service?.hostname ? `http://${service.hostname}` : undefined),
        message: infraReport.report_warnings?.length
          ? "Deployment completed, but infrastructure report has warnings."
          : "Deployment completed and infrastructure report generated."
      };
    } catch (error) {
      return {
        ...base,
        status: "deployed_with_report_warnings",
        report_warnings: [`Could not generate infrastructure report: ${error instanceof Error ? error.message : String(error)}`],
        cleanup: cleanupCommands(stackName, region),
        message: "Deployment completed, but infrastructure report generation failed."
      };
    }
  }
}

export async function runCommand(command: string, args: string[], options: { cwd: string; timeoutMs: number; env: NodeJS.ProcessEnv }): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
    }, options.timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({
        command: formatCommand(command, args),
        exitCode: 127,
        stdout,
        stderr: `${stderr}${error.message}`
      });
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({
        command: formatCommand(command, args),
        exitCode: code ?? 1,
        stdout,
        stderr
      });
    });
  });
}

function baseContext(workspace: string, commands: CommandResult[], stackName: string, clusterName: string, namespace: string, appName: string, region: string, outputs: Record<string, string> = {}, cloudformationStatus?: string, metadata: Record<string, unknown> = {}): Omit<ExecutorResult, "status" | "executor_status"> {
  return {
    workspace,
    commands,
    logs_summary: summarizeCommands(commands),
    stack_name: stackName,
    cloudformation_status: cloudformationStatus,
    cluster_name: clusterName,
    namespace,
    app_name: appName,
    aws_region: region,
    infra_details: {
      vpc_id: outputs.VpcId,
      cluster_endpoint: outputs.ClusterEndpoint,
      ecr_repository_uri: outputs.ECRRepositoryUri,
      node_instance_type: parameterValue(metadata, "NodeInstanceType"),
      node_desired_capacity: numberFromString(parameterValue(metadata, "NodeDesiredCapacity")),
      kubernetes_version: parameterValue(metadata, "KubernetesVersion")
    }
  };
}

function failedResult(context: Omit<ExecutorResult, "status" | "executor_status">, diagnostic?: FailureDiagnostic, status: "failed" | "blocked" = "failed"): ExecutorResult {
  return {
    ...context,
    status,
    executor_status: status === "blocked" ? "blocked" : "failed",
    ...diagnostic
  };
}

function localSuccess(command: string, stdout: string): CommandResult {
  return { command, exitCode: 0, stdout, stderr: "" };
}

function localFailure(command: string, stderr: string): CommandResult {
  return { command, exitCode: 1, stdout: "", stderr };
}

function summarizeCommands(commands: CommandResult[]): string {
  return commands.map((command) => `${command.exitCode === 0 ? "OK" : "FAILED"}: ${command.command}`).join("\n");
}

function extractOidcId(value: string): string | undefined {
  const match = value.trim().match(/\/id\/([A-Za-z0-9_-]+)/);
  return match?.[1];
}

function parameterOverrideArgs(metadata: Record<string, unknown>): string[] {
  const raw = metadata.cloudformation_parameters;
  if (!Array.isArray(raw) || raw.length === 0) return [];

  const overrides: string[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const parameter = item as Record<string, unknown>;
    const key = stringValue(parameter.ParameterKey);
    const value = stringValue(parameter.ParameterValue);
    if (!key || value === undefined) continue;
    if (!/^[A-Za-z0-9]+$/.test(key)) throw new Error(`Unsafe CloudFormation parameter key: ${key}`);
    overrides.push(`${key}=${value}`);
  }

  return overrides.length > 0 ? ["--parameter-overrides", ...overrides] : [];
}

function parameterValue(metadata: Record<string, unknown>, key: string): string | undefined {
  const raw = metadata.cloudformation_parameters;
  if (!Array.isArray(raw)) return undefined;
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const parameter = item as Record<string, unknown>;
    if (parameter.ParameterKey === key) return stringValue(parameter.ParameterValue);
  }
  return undefined;
}

function numberFromString(value: string | undefined): number | undefined {
  if (!value || !Number.isFinite(Number(value))) return undefined;
  return Number(value);
}

function normalizeCloudFormationTemplate(content: string): { content: string; changed: boolean; summary: string } {
  const lines = content.split(/\r?\n/);
  const output: string[] = [];
  let removedSections = 0;

  for (let index = 0; index < lines.length;) {
    if (!/^  [A-Za-z0-9]+:\s*$/.test(lines[index])) {
      output.push(lines[index]);
      index += 1;
      continue;
    }

    const blockStart = index;
    index += 1;
    while (index < lines.length && !/^  [A-Za-z0-9]+:\s*$/.test(lines[index])) index += 1;
    const block = lines.slice(blockStart, index);
    if (!block.some((line) => /^\s{4}Type:\s*AWS::EC2::SecurityGroup\s*$/.test(line))) {
      output.push(...block);
      continue;
    }

    const normalizedBlock: string[] = [];
    for (let blockIndex = 0; blockIndex < block.length;) {
      if (/^\s{6}SecurityGroupIngress:\s*$/.test(block[blockIndex])) {
        const sectionStart = blockIndex;
        blockIndex += 1;
        while (blockIndex < block.length && !/^\s{6}[A-Za-z0-9]+:\s*/.test(block[blockIndex])) blockIndex += 1;
        const section = block.slice(sectionStart, blockIndex);
        if (section.some((line) => line.includes("SourceSecurityGroupId:"))) {
          removedSections += 1;
          continue;
        }
        normalizedBlock.push(...section);
        continue;
      }
      normalizedBlock.push(block[blockIndex]);
      blockIndex += 1;
    }
    output.push(...normalizedBlock);
  }

  return {
    content: output.join("\n"),
    changed: removedSections > 0,
    summary: removedSections > 0
      ? `Removed ${removedSections} inline SecurityGroupIngress section(s) with SourceSecurityGroupId from AWS::EC2::SecurityGroup resources to avoid CloudFormation circular dependencies.`
      : "No CloudFormation normalization required."
  };
}

function applyPublicHelloWorldImageOverride(manifest: string): string {
  let updated = manifest
    .replace(/image:\s*(PATCH_ECR_IMAGE_URI|ECR_REPOSITORY_URI_PATCH_TARGET)(:latest)?/g, "image: nginxinc/nginx-unprivileged:alpine")
    .replace(/image:\s*\S+\.dkr\.ecr\.[^\s]+(:[A-Za-z0-9._-]+)?/g, "image: nginxinc/nginx-unprivileged:alpine")
    .replace(/imagePullPolicy:\s*Always/g, "imagePullPolicy: IfNotPresent")
    .replace(/containerPort:\s*80/g, "containerPort: 8080")
    .replace(/targetPort:\s*80/g, "targetPort: http");

  if (updated.includes("nginxinc/nginx-unprivileged:alpine") && !updated.includes("imagePullPolicy: IfNotPresent")) {
    updated = updated.replace(/image:\s*nginxinc\/nginx-unprivileged:alpine/g, "image: nginxinc/nginx-unprivileged:alpine\n          imagePullPolicy: IfNotPresent");
  }
  return updated;
}

function determineImageMode(manifest: string): string | undefined {
  if (/image:\s*public\.ecr\.aws\/nginx\/nginx:1\.25-alpine/.test(manifest)) return "public_nginx";
  if (/image:\s*nginxinc\/nginx-unprivileged:alpine/.test(manifest)) return "public_nginx_unprivileged";
  if (/image:\s*(PATCH_ECR_IMAGE_URI|ECR_REPOSITORY_URI_PATCH_TARGET)(:latest)?/.test(manifest)) return "public_nginx_unprivileged";
  if (/image:\s*\S+\.dkr\.ecr\.[^\s]+(:[A-Za-z0-9._-]+)?/.test(manifest)) return "public_nginx_unprivileged";
  return undefined;
}

function extractKubernetesName(manifest: string, kind: string): string | undefined {
  const docs = manifest.split(/\n---\s*\n/);
  for (const doc of docs) {
    if (!new RegExp(`kind:\\s*${kind}\\b`).test(doc)) continue;
    const match = doc.match(/metadata:\s*\n(?:\s+[A-Za-z0-9_.-]+:.*\n)*\s+name:\s*([A-Za-z0-9_.-]+)/);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function formatCommand(command: string, args: string[]): string {
  return [command, ...args].join(" ");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
