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
  jobRetentionMs: 60000
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

    expect(plan.map((step) => step.command)).toEqual(["sam", "sam", "aws", "aws", "kubectl"]);
    expect(plan[1].args).toContain("--no-confirm-changeset");
    expect(plan[2].args[0]).toBe("cloudformation");
    expect(plan[4].args).toEqual(["apply", "-n", "hello-world", "-f", "k8s.yaml"]);
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
});
