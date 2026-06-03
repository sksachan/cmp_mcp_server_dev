import { mkdir, writeFile } from "node:fs/promises";
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

    commands.push(await this.runner("sam", ["validate", "--template-file", bundle.cloudformationTemplate.filename], {
      cwd: workspace,
      timeoutMs: this.config.executorCommandTimeoutMs,
      env
    }));

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
      "--no-fail-on-empty-changeset"
    ], {
      cwd: workspace,
      timeoutMs: this.config.executorCommandTimeoutMs,
      env
    }));

    if (bundle.kubernetesManifest) {
      commands.push(await this.runner("aws", ["eks", "update-kubeconfig", "--name", clusterName, "--region", region], {
        cwd: workspace,
        timeoutMs: this.config.executorCommandTimeoutMs,
        env
      }));

      commands.push(await this.runner("kubectl", ["apply", "-n", namespace, "-f", bundle.kubernetesManifest.filename], {
        cwd: workspace,
        timeoutMs: this.config.executorCommandTimeoutMs,
        env
      }));
    }

    const failed = commands.find((command) => command.exitCode !== 0);
    return {
      status: failed ? "failed" : "deployed",
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
          "--no-fail-on-empty-changeset"
        ]
      }
    ];

    if (bundle.kubernetesManifest) {
      plan.push(
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

function formatCommand(command: string, args: string[]): string {
  return [command, ...args].join(" ");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
