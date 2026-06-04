import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { validateArtifactBundle } from "../src/artifacts.js";
import { DeploymentExecutor } from "../src/deploymentExecutor.js";
import type { Config } from "../src/config.js";
import type { DeployRequest } from "../src/schemas.js";

const config: Config = {
  nodeEnv: "test",
  port: 3000,
  logLevel: "silent",
  mcpSharedSecret: "secret",
  bodhiApiBaseUrl: "https://bodhi.example/api",
  bodhiPatToken: "pat",
  bodhiWorkflowId: "workflow-id",
  bodhiTaskId: "task-id",
  bodhiHitlPollIntervalMs: 1,
  bodhiRunPollIntervalMs: 1,
  bodhiTimeoutMs: 1000,
  bodhiStartTimeoutMs: 1000,
  oauthLoginPassword: "oauth-password",
  oauthAccessTokenTtlSeconds: 3600,
  executorCommandTimeoutMs: 1000,
  requestDedupTtlMs: 1000,
  jobRetentionMs: 60000,
  usePublicHelloWorldImage: true
};

const request: DeployRequest = {
  deployment_context: "Purpose: POC validation. Environment: dev. Audience: personal demo. Maturity: MVP. Components: minimal EKS app with cost-conscious defaults.",
  app_name: "hello-world",
  github_repo: "sksachan/cmp_mcp_server_dev",
  github_branch: "main",
  aws_account_id: "051370627449",
  aws_account_alias: "demo",
  aws_region: "us-east-1",
  cluster_name: "hello-world-demo",
  namespace: "hello-world",
  environment: "dev",
  budget_limit_usd: 100,
  confirm_deploy: true
};

describe("DeploymentExecutor", () => {
  it("builds the fixed command plan without arbitrary commands", () => {
    const bundle = validateArtifactBundle({
      status: "artifacts_ready",
      deployment_artifacts: [
        {
          type: "cloudformation_template",
          filename: "template.yaml",
          content: "Resources: {}\n"
        },
        {
          type: "kubernetes_manifest",
          filename: "k8s.yaml",
          content: "apiVersion: v1\nkind: Namespace\n"
        },
        {
          type: "metadata",
          filename: "params.json",
          content: JSON.stringify({
            stack_name: "hello-world-dev",
            cluster_name: "hello-world-demo",
            namespace: "hello-world",
            aws_region: "us-east-1"
          })
        }
      ]
    });

    const executor = new DeploymentExecutor(config);
    const plan = executor.buildCommandPlan(bundle, request);

    expect(plan.map((step) => step.command)).toEqual(["sam", "aws", "sam", "aws", "aws", "kubectl", "kubectl", "kubectl"]);
    expect(plan[2].args).toContain("--no-confirm-changeset");
    expect(plan[1].args[0]).toBe("cloudformation");
    expect(plan[5].args).toEqual(["apply", "-n", "hello-world", "-f", "k8s.yaml"]);
  });

  it("normalizes inline security group ingress before CloudFormation deploy", async () => {
    const bundle = validateArtifactBundle({
      status: "artifacts_ready",
      deployment_artifacts: [
        {
          type: "cloudformation_template",
          filename: "template.yaml",
          content: [
            "Resources:",
            "  ClusterSecurityGroup:",
            "    Type: AWS::EC2::SecurityGroup",
            "    Properties:",
            "      GroupDescription: cluster",
            "      VpcId: vpc-123",
            "  NodeSecurityGroup:",
            "    Type: AWS::EC2::SecurityGroup",
            "    Properties:",
            "      GroupDescription: nodes",
            "      VpcId: vpc-123",
            "      SecurityGroupIngress:",
            "        - IpProtocol: '-1'",
            "          SourceSecurityGroupId: !Ref ClusterSecurityGroup",
            "        - IpProtocol: '-1'",
            "          SourceSecurityGroupId: !Ref NodeSecurityGroup",
            "      SecurityGroupEgress:",
            "        - IpProtocol: '-1'",
            "          CidrIp: 0.0.0.0/0",
            "  ClusterToNodeIngress:",
            "    Type: AWS::EC2::SecurityGroupIngress",
            "    Properties:",
            "      GroupId: !Ref NodeSecurityGroup",
            "      SourceSecurityGroupId: !Ref ClusterSecurityGroup",
            ""
          ].join("\n")
        },
        {
          type: "metadata",
          filename: "params.json",
          content: JSON.stringify({
            stack_name: "hello-world-dev",
            cluster_name: "hello-world-demo",
            namespace: "hello-world",
            aws_region: "us-east-1",
            cloudformation_parameters: [
              { ParameterKey: "ClusterName", ParameterValue: "hello-world-demo" },
              { ParameterKey: "NodeDesiredCapacity", ParameterValue: "2" }
            ]
          })
        }
      ]
    });
    const seenDeployArgs: string[][] = [];
    const runner = async (command: string, args: string[], options: { cwd: string }) => {
      if (command === "sam" && args[0] === "validate") {
        const template = await readFile(`${options.cwd}/template.yaml`, "utf8");
        expect(template).not.toContain("      SecurityGroupIngress:\n        - IpProtocol: '-1'\n          SourceSecurityGroupId: !Ref ClusterSecurityGroup");
        expect(template).toContain("  ClusterToNodeIngress:");
      }
      if (command === "sam" && args[0] === "deploy") {
        seenDeployArgs.push(args);
      }
      if (command === "aws" && args[0] === "cloudformation" && args.includes("Stacks[0].StackStatus")) {
        return {
          command: [command, ...args].join(" "),
          exitCode: 0,
          stdout: "CREATE_COMPLETE",
          stderr: ""
        };
      }
      if (command === "aws" && args[0] === "cloudformation" && args.includes("Stacks[0]")) {
        return {
          command: [command, ...args].join(" "),
          exitCode: 0,
          stdout: JSON.stringify({
            StackStatus: "CREATE_COMPLETE",
            Outputs: [
              { OutputKey: "VpcId", OutputValue: "vpc-123" },
              { OutputKey: "ClusterEndpoint", OutputValue: "https://cluster.example" }
            ]
          }),
          stderr: ""
        };
      }
      return {
        command: [command, ...args].join(" "),
        exitCode: 0,
        stdout: "",
        stderr: ""
      };
    };

    const executor = new DeploymentExecutor(config, runner);
    const result = await executor.execute(bundle, request);

    expect(result.status).toBe("deployed");
    expect(result.commands[0].command).toBe("normalize CloudFormation template");
    expect(seenDeployArgs[0]).toContain("--parameter-overrides");
    expect(seenDeployArgs[0]).toContain("ClusterName=hello-world-demo");
    expect(seenDeployArgs[0]).toContain("NodeDesiredCapacity=2");
  });

  it("blocks ROLLBACK_COMPLETE stacks during preflight before sam deploy", async () => {
    const bundle = validateArtifactBundle({
      status: "artifacts_ready",
      deployment_artifacts: [
        {
          type: "cloudformation_template",
          filename: "template.yaml",
          content: "Resources: {}\n"
        },
        {
          type: "metadata",
          filename: "params.json",
          content: JSON.stringify({
            stack_name: "hello-world-dev-eks",
            cluster_name: "hello-world-demo",
            namespace: "hello-world",
            aws_region: "us-east-1"
          })
        }
      ]
    });
    const commands: string[] = [];
    const runner = async (command: string, args: string[]) => {
      commands.push([command, ...args].join(" "));
      if (command === "aws" && args.includes("Stacks[0].StackStatus")) {
        return { command: [command, ...args].join(" "), exitCode: 0, stdout: "ROLLBACK_COMPLETE", stderr: "" };
      }
      return { command: [command, ...args].join(" "), exitCode: 0, stdout: "", stderr: "" };
    };

    const result = await new DeploymentExecutor(config, runner).execute(bundle, request);

    expect(result.status).toBe("failed");
    expect(result.failure_stage).toBe("cloudformation_preflight");
    expect(result.root_cause).toContain("ROLLBACK_COMPLETE");
    expect(commands.some((command) => command.startsWith("sam deploy"))).toBe(false);
  });

  it("applies public image override and runs rollout/service validation", async () => {
    const bundle = validateArtifactBundle({
      status: "artifacts_ready",
      deployment_artifacts: [
        {
          type: "cloudformation_template",
          filename: "template.yaml",
          content: "Resources: {}\n"
        },
        {
          type: "kubernetes_manifest",
          filename: "k8s.yaml",
          content: [
            "apiVersion: apps/v1",
            "kind: Deployment",
            "metadata:",
            "  name: hello-world",
            "spec:",
            "  template:",
            "    spec:",
            "      containers:",
            "        - name: hello-world",
            "          image: PATCH_ECR_IMAGE_URI:latest",
            "          imagePullPolicy: Always",
            "          ports:",
            "            - name: http",
            "              containerPort: 80",
            "---",
            "apiVersion: v1",
            "kind: Service",
            "metadata:",
            "  name: hello-world-svc",
            "spec:",
            "  type: LoadBalancer",
            "  ports:",
            "    - name: http",
            "      port: 80",
            "      targetPort: 80",
            ""
          ].join("\n")
        },
        {
          type: "metadata",
          filename: "params.json",
          content: JSON.stringify({
            stack_name: "hello-world-dev-eks",
            cluster_name: "hello-world-demo",
            namespace: "hello-world",
            aws_region: "us-east-1",
            cloudformation_parameters: [
              { ParameterKey: "NodeInstanceType", ParameterValue: "t3.small" },
              { ParameterKey: "NodeDesiredCapacity", ParameterValue: "1" },
              { ParameterKey: "KubernetesVersion", ParameterValue: "1.29" }
            ],
            post_deploy_patches: [
              {
                artifact: "k8s.yaml",
                placeholder: "PATCH_ECR_IMAGE_URI",
                source_cf_output_key: "ECRRepositoryUri",
                patch_type: "string_replace"
              }
            ]
          })
        }
      ]
    });
    const commands: string[] = [];
    const runner = async (command: string, args: string[], options: { cwd: string }) => {
      commands.push([command, ...args].join(" "));
      if (command === "aws" && args.includes("Stacks[0].StackStatus")) return { command: [command, ...args].join(" "), exitCode: 0, stdout: "CREATE_COMPLETE", stderr: "" };
      if (command === "aws" && args.includes("Stacks[0]")) {
        return {
          command: [command, ...args].join(" "),
          exitCode: 0,
          stdout: JSON.stringify({
            StackStatus: "CREATE_COMPLETE",
            Outputs: [
              { OutputKey: "ECRRepositoryUri", OutputValue: "123.dkr.ecr.us-east-1.amazonaws.com/app" },
              { OutputKey: "VpcId", OutputValue: "vpc-123" },
              { OutputKey: "ClusterEndpoint", OutputValue: "https://cluster.example" }
            ]
          }),
          stderr: ""
        };
      }
      if (command === "kubectl" && args[0] === "apply") {
        const manifest = await readFile(`${options.cwd}/k8s.yaml`, "utf8");
        expect(manifest).toContain("image: nginxinc/nginx-unprivileged:alpine");
        expect(manifest).toContain("imagePullPolicy: IfNotPresent");
        expect(manifest).toContain("containerPort: 8080");
        expect(manifest).toContain("targetPort: http");
      }
      if (command === "kubectl" && args.some((arg) => arg.includes("jsonpath"))) {
        return { command: [command, ...args].join(" "), exitCode: 0, stdout: "abc.elb.amazonaws.com", stderr: "" };
      }
      return { command: [command, ...args].join(" "), exitCode: 0, stdout: "", stderr: "" };
    };

    const result = await new DeploymentExecutor(config, runner).execute(bundle, request);

    expect(result.status).toBe("deployed");
    expect(result.image_mode).toBe("public_nginx_unprivileged");
    expect(result.service_hostname).toBe("abc.elb.amazonaws.com");
    expect(result.application_url).toBe("http://abc.elb.amazonaws.com");
    expect(result.infra_details?.node_instance_type).toBe("t3.small");
    expect(result.infra_details?.node_desired_capacity).toBe(1);
    expect(result.infra_details?.kubernetes_version).toBe("1.29");
    expect(commands.some((command) => command.startsWith("kubectl rollout status"))).toBe(true);
    expect(commands.some((command) => command.startsWith("kubectl get pods"))).toBe(true);
  });
});
