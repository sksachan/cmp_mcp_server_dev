import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import type { Config } from "./config.js";
import type { DeployRequest } from "./schemas.js";
import type { DeploymentArtifact, ValidatedArtifactBundle } from "./artifacts.js";

export type CommandRunner = (command: string, args: string[], options: { cwd: string; timeoutMs: number; env: NodeJS.ProcessEnv }) => Promise<CommandResult>;

export type CommandResult = {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type ExecutorResult = {
  status: "deployed" | "failed";
  workspace: string;
  commands: CommandResult[];
  application_url?: string;
  logs_summary: string;
};

export class DeploymentExecutor {
  private readonly config: Config;
  private readonly runner: CommandRunner;

  constructor(config: Config, runner: CommandRunner = runCommand) {
    this.config = config;
    this.runner = runner;
  }

  async execute(bundle: ValidatedArtifactBundle, request: DeployRequest): Promise<ExecutorResult> {
    const workspace = await this.writeArtifacts(bundle.deployment_artifacts);
    const stackName = stringValue(bundle.metadata.stack_name) ?? `${request.app_name}-${request.environment}`;
    const clusterName = stringValue(bundle.metadata.cluster_name) ?? request.cluster_name;
    const namespace = stringValue(bundle.metadata.namespace) ?? request.namespace;
    const region = stringValue(bundle.metadata.aws_region) ?? request.aws_region;
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
      commands.push({
        command: "normalize CloudFormation template",
        exitCode: 0,
        stdout: normalized.summary,
        stderr: ""
      });
    }

    if (template.includes("REPLACEME_OIDC_ID")) {
      const describeCluster = await this.runner("aws", [
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
      ], {
        cwd: workspace,
        timeoutMs: this.config.executorCommandTimeoutMs,
        env
      });
      commands.push(describeCluster);
      if (describeCluster.exitCode !== 0) return failedResult(workspace, commands);

      const oidcId = extractOidcId(describeCluster.stdout);
      if (!oidcId) {
        commands.push(localFailure("resolve EKS OIDC provider ID", `Could not extract OIDC provider ID from: ${describeCluster.stdout}`));
        return failedResult(workspace, commands);
      }
      await writeFile(templatePath, template.replaceAll("REPLACEME_OIDC_ID", oidcId), "utf8");
    }

    commands.push(await this.runner("sam", ["validate", "--template-file", bundle.cloudformationTemplate.filename], {
      cwd: workspace,
      timeoutMs: this.config.executorCommandTimeoutMs,
      env
    }));
    if (lastCommandFailed(commands)) return failedResult(workspace, commands);

    commands.push(await this.runner("sam", [
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
    ], {
      cwd: workspace,
      timeoutMs: this.config.executorCommandTimeoutMs,
      env
    }));
    if (lastCommandFailed(commands)) return failedResult(workspace, commands);

    if (bundle.kubernetesManifest) {
      const manifest = await readFile(manifestPath!, "utf8");
      if (manifest.includes("REPLACEME_POD_ROLE_ARN")) {
        const describeStack = await this.runner("aws", [
          "cloudformation",
          "describe-stacks",
          "--stack-name",
          stackName,
          "--region",
          region,
          "--query",
          "Stacks[0].Outputs[?OutputKey=='PodRoleArn'].OutputValue | [0]",
          "--output",
          "text"
        ], {
          cwd: workspace,
          timeoutMs: this.config.executorCommandTimeoutMs,
          env
        });
        commands.push(describeStack);
        if (describeStack.exitCode !== 0) return failedResult(workspace, commands);

        const podRoleArn = describeStack.stdout.trim();
        if (!podRoleArn || podRoleArn === "None") {
          commands.push(localFailure("resolve PodRoleArn stack output", `CloudFormation stack ${stackName} did not return PodRoleArn.`));
          return failedResult(workspace, commands);
        }
        await writeFile(manifestPath!, manifest.replaceAll("REPLACEME_POD_ROLE_ARN", podRoleArn), "utf8");
      }

      commands.push(await this.runner("aws", ["eks", "update-kubeconfig", "--name", clusterName, "--region", region], {
        cwd: workspace,
        timeoutMs: this.config.executorCommandTimeoutMs,
        env
      }));
      if (lastCommandFailed(commands)) return failedResult(workspace, commands);

      commands.push(await this.runner("kubectl", ["apply", "-n", namespace, "-f", bundle.kubernetesManifest.filename], {
        cwd: workspace,
        timeoutMs: this.config.executorCommandTimeoutMs,
        env
      }));
      if (lastCommandFailed(commands)) return failedResult(workspace, commands);
    }

    return {
      status: "deployed",
      workspace,
      commands,
      application_url: stringValue(bundle.metadata.application_url),
      logs_summary: summarizeCommands(commands)
    };
  }

  buildCommandPlan(bundle: ValidatedArtifactBundle, request: DeployRequest): Array<{ command: string; args: string[] }> {
    const stackName = stringValue(bundle.metadata.stack_name) ?? `${request.app_name}-${request.environment}`;
    const clusterName = stringValue(bundle.metadata.cluster_name) ?? request.cluster_name;
    const namespace = stringValue(bundle.metadata.namespace) ?? request.namespace;
    const region = stringValue(bundle.metadata.aws_region) ?? request.aws_region;
    const parameterOverrides = parameterOverrideArgs(bundle.metadata);
    const plan = [
      { command: "sam", args: ["validate", "--template-file", bundle.cloudformationTemplate.filename] },
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
          ...parameterOverrides
        ]
      }
    ];

    if (bundle.kubernetesManifest) {
      plan.push(
        { command: "aws", args: ["cloudformation", "describe-stacks", "--stack-name", stackName, "--region", region, "--query", "Stacks[0].Outputs[?OutputKey=='PodRoleArn'].OutputValue | [0]", "--output", "text"] },
        { command: "aws", args: ["eks", "update-kubeconfig", "--name", clusterName, "--region", region] },
        { command: "kubectl", args: ["apply", "-n", namespace, "-f", bundle.kubernetesManifest.filename] }
      );
    }

    return plan;
  }

  private async writeArtifacts(artifacts: DeploymentArtifact[]): Promise<string> {
    const workspace = join(tmpdir(), `cmp-mcp-deploy-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(workspace, { recursive: true });

    for (const artifact of artifacts) {
      await writeFile(join(workspace, artifact.filename), artifact.content, "utf8");
    }

    return workspace;
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

function summarizeCommands(commands: CommandResult[]): string {
  return commands.map((command) => `${command.exitCode === 0 ? "OK" : "FAILED"}: ${command.command}`).join("\n");
}

function failedResult(workspace: string, commands: CommandResult[]): ExecutorResult {
  return {
    status: "failed",
    workspace,
    commands,
    logs_summary: summarizeCommands(commands)
  };
}

function lastCommandFailed(commands: CommandResult[]): boolean {
  return commands.length > 0 && commands[commands.length - 1].exitCode !== 0;
}

function localFailure(command: string, stderr: string): CommandResult {
  return {
    command,
    exitCode: 1,
    stdout: "",
    stderr
  };
}

function extractOidcId(value: string): string | undefined {
  const trimmed = value.trim();
  const match = trimmed.match(/\/id\/([A-Za-z0-9_-]+)/);
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
    if (!/^[A-Za-z0-9]+$/.test(key)) {
      throw new Error(`Unsafe CloudFormation parameter key: ${key}`);
    }
    overrides.push(`${key}=${value}`);
  }

  return overrides.length > 0 ? ["--parameter-overrides", ...overrides] : [];
}

function normalizeCloudFormationTemplate(content: string): { content: string; changed: boolean; summary: string } {
  const lines = content.split(/\r?\n/);
  const output: string[] = [];
  let removedSections = 0;

  for (let index = 0; index < lines.length;) {
    const resourceMatch = lines[index].match(/^  ([A-Za-z0-9]+):\s*$/);
    if (!resourceMatch) {
      output.push(lines[index]);
      index += 1;
      continue;
    }

    const blockStart = index;
    index += 1;
    while (index < lines.length && !/^  [A-Za-z0-9]+:\s*$/.test(lines[index])) {
      index += 1;
    }
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
        while (blockIndex < block.length && !/^\s{6}[A-Za-z0-9]+:\s*/.test(block[blockIndex])) {
          blockIndex += 1;
        }
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

function formatCommand(command: string, args: string[]): string {
  return [command, ...args].join(" ");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
