import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { validateArtifactBundle } from "../src/artifacts.js";
import { applyPublicHelloWorldImageOverride, DeploymentExecutor, validateRenderedKubernetesManifest } from "../src/deploymentExecutor.js";
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
  stack_name: "hello-world-dev-eks",
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
  it("applies public nginx patch idempotently without corrupting ports", () => {
    const manifest = [
      "apiVersion: apps/v1",
      "kind: Deployment",
      "metadata:",
      "  name: hello-world-v5",
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
      "          readinessProbe:",
      "            httpGet:",
      "              path: /",
      "              port: 80",
      "          livenessProbe:",
      "            httpGet:",
      "              path: /",
      "              port: 8080",
      "---",
      "apiVersion: v1",
      "kind: Service",
      "metadata:",
      "  name: hello-world-v5",
      "spec:",
      "  type: LoadBalancer",
      "  ports:",
      "    - name: http",
      "      port: 80",
      "      targetPort: 80",
      ""
    ].join("\n");

    const once = applyPublicHelloWorldImageOverride(manifest);
    const twice = applyPublicHelloWorldImageOverride(once);

    expect(twice).toBe(once);
    expect(once).toContain("image: nginxinc/nginx-unprivileged:alpine");
    expect(once).toContain("imagePullPolicy: IfNotPresent");
    expect(once).toContain("containerPort: 8080");
    expect(once).not.toContain("containerPort: 808080");
    expect(once).toContain("      port: 80");
    expect(once).toContain("targetPort: http");
    expect(once.match(/port: http/g)?.length).toBe(2);
    expect(validateRenderedKubernetesManifest(once)).toBeUndefined();
  });

  it("leaves existing containerPort 8080 stable and rejects malformed ports", () => {
    const manifest = [
      "apiVersion: apps/v1",
      "kind: Deployment",
      "metadata:",
      "  name: hello-world-v5",
      "spec:",
      "  template:",
      "    spec:",
      "      containers:",
      "        - name: hello-world",
      "          image: nginxinc/nginx-unprivileged:alpine",
      "          ports:",
      "            - name: http",
      "              containerPort: 8080",
      ""
    ].join("\n");

    const patched = applyPublicHelloWorldImageOverride(applyPublicHelloWorldImageOverride(manifest));

    expect(patched).toContain("containerPort: 8080");
    expect(patched).not.toContain("808080");
    expect(validateRenderedKubernetesManifest("containerPort: 808080\n")).toContain("Invalid Kubernetes containerPort 808080");
  });

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
          type: "kubernetes_manifest",
          filename: "k8s.yaml",
          content: "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: hello-world\n"
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
          exitCode: 255,
          stdout: "",
          stderr: "ValidationError: Stack with id hello-world-dev-eks does not exist"
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

    expect(["deployed", "deployed_with_report_warnings"]).toContain(result.status);
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
          type: "kubernetes_manifest",
          filename: "k8s.yaml",
          content: "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: hello-world\n"
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

  it("blocks existing completed stacks unless update_existing is true", async () => {
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
          content: "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: hello-world\n"
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
        return { command: [command, ...args].join(" "), exitCode: 0, stdout: "CREATE_COMPLETE", stderr: "" };
      }
      return { command: [command, ...args].join(" "), exitCode: 0, stdout: "", stderr: "" };
    };

    const result = await new DeploymentExecutor(config, runner).execute(bundle, request);

    expect(result.status).toBe("failed");
    expect(result.failure_stage).toBe("cloudformation_preflight");
    expect(result.root_cause).toContain("already exists");
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
      if (command === "aws" && args.includes("Stacks[0].StackStatus")) return { command: [command, ...args].join(" "), exitCode: 255, stdout: "", stderr: "ValidationError: Stack with id hello-world-dev-eks does not exist" };
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
      if (command === "aws" && args[0] === "cloudformation" && args[1] === "describe-stacks") {
        return {
          command: [command, ...args].join(" "),
          exitCode: 0,
          stdout: JSON.stringify({
            Stacks: [
              {
                StackId: "stack-id",
                StackName: "hello-world-dev-eks",
                StackStatus: "CREATE_COMPLETE",
                CreationTime: "2026-06-04T10:00:00.000Z",
                LastUpdatedTime: "2026-06-04T10:10:00.000Z",
                Outputs: [
                  { OutputKey: "VpcId", OutputValue: "vpc-123" },
                  { OutputKey: "ClusterName", OutputValue: "hello-world-demo" },
                  { OutputKey: "ClusterEndpoint", OutputValue: "https://cluster.example" },
                  { OutputKey: "ECRRepositoryUri", OutputValue: "123.dkr.ecr.us-east-1.amazonaws.com/app" }
                ]
              }
            ]
          }),
          stderr: ""
        };
      }
      if (command === "aws" && args[0] === "cloudformation" && args[1] === "list-stack-resources") {
        return {
          command: [command, ...args].join(" "),
          exitCode: 0,
          stdout: JSON.stringify({
            StackResourceSummaries: [
              { LogicalResourceId: "VPC", PhysicalResourceId: "vpc-123", ResourceType: "AWS::EC2::VPC", ResourceStatus: "CREATE_COMPLETE" },
              { LogicalResourceId: "Repository", PhysicalResourceId: "app", ResourceType: "AWS::ECR::Repository", ResourceStatus: "CREATE_COMPLETE" }
            ]
          }),
          stderr: ""
        };
      }
      if (command === "aws" && args[0] === "ec2" && args[1] === "describe-vpcs") {
        return { command: [command, ...args].join(" "), exitCode: 0, stdout: JSON.stringify({ Vpcs: [{ VpcId: "vpc-123", CidrBlock: "10.0.0.0/16" }] }), stderr: "" };
      }
      if (command === "aws" && args[0] === "ec2" && args[1] === "describe-subnets") {
        return {
          command: [command, ...args].join(" "),
          exitCode: 0,
          stdout: JSON.stringify({
            Subnets: [
              { SubnetId: "subnet-public", CidrBlock: "10.0.1.0/24", AvailabilityZone: "us-east-1a", MapPublicIpOnLaunch: true, State: "available" },
              { SubnetId: "subnet-private", CidrBlock: "10.0.11.0/24", AvailabilityZone: "us-east-1a", MapPublicIpOnLaunch: false, State: "available" }
            ]
          }),
          stderr: ""
        };
      }
      if (command === "aws" && args[0] === "ec2" && args[1] === "describe-nat-gateways") {
        return { command: [command, ...args].join(" "), exitCode: 0, stdout: JSON.stringify({ NatGateways: [{ NatGatewayId: "nat-123", State: "available" }] }), stderr: "" };
      }
      if (command === "aws" && args[0] === "ec2" && args[1] === "describe-route-tables") {
        return { command: [command, ...args].join(" "), exitCode: 0, stdout: JSON.stringify({ RouteTables: [{ RouteTableId: "rtb-123" }] }), stderr: "" };
      }
      if (command === "aws" && args[0] === "ec2" && args[1] === "describe-security-groups") {
        return { command: [command, ...args].join(" "), exitCode: 0, stdout: JSON.stringify({ SecurityGroups: [{ GroupId: "sg-123" }] }), stderr: "" };
      }
      if (command === "aws" && args[0] === "eks" && args[1] === "describe-cluster") {
        return {
          command: [command, ...args].join(" "),
          exitCode: 0,
          stdout: JSON.stringify({ cluster: { name: "hello-world-demo", arn: "arn:cluster", status: "ACTIVE", version: "1.29", endpoint: "https://cluster.example" } }),
          stderr: ""
        };
      }
      if (command === "aws" && args[0] === "eks" && args[1] === "list-nodegroups") {
        return { command: [command, ...args].join(" "), exitCode: 0, stdout: JSON.stringify({ nodegroups: ["ng-1"] }), stderr: "" };
      }
      if (command === "aws" && args[0] === "eks" && args[1] === "describe-nodegroup") {
        return {
          command: [command, ...args].join(" "),
          exitCode: 0,
          stdout: JSON.stringify({
            nodegroup: {
              nodegroupName: "ng-1",
              status: "ACTIVE",
              instanceTypes: ["t3.small"],
              scalingConfig: { desiredSize: 1, minSize: 1, maxSize: 2 },
              subnets: ["subnet-private"],
              nodeRole: "arn:node-role"
            }
          }),
          stderr: ""
        };
      }
      if (command === "aws" && args[0] === "ecr" && args[1] === "describe-repositories") {
        return { command: [command, ...args].join(" "), exitCode: 0, stdout: JSON.stringify({ repositories: [{ repositoryName: "app", repositoryUri: "123.dkr.ecr.us-east-1.amazonaws.com/app" }] }), stderr: "" };
      }
      if (command === "aws" && args[0] === "ecr" && args[1] === "describe-images") {
        return { command: [command, ...args].join(" "), exitCode: 0, stdout: JSON.stringify({ imageDetails: [] }), stderr: "" };
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
      if (command === "kubectl" && args[0] === "get" && args[1] === "deployment") {
        return {
          command: [command, ...args].join(" "),
          exitCode: 0,
          stdout: JSON.stringify({
            metadata: { name: "hello-world" },
            spec: { replicas: 1, template: { spec: { containers: [{ image: "nginxinc/nginx-unprivileged:alpine" }] } } },
            status: { availableReplicas: 1 }
          }),
          stderr: ""
        };
      }
      if (command === "kubectl" && args[0] === "get" && args[1] === "pods") {
        return {
          command: [command, ...args].join(" "),
          exitCode: 0,
          stdout: JSON.stringify({ items: [{ metadata: { name: "pod-1" }, status: { phase: "Running", podIP: "10.0.1.10", containerStatuses: [{ restartCount: 0 }] }, spec: { nodeName: "node-1" } }] }),
          stderr: ""
        };
      }
      if (command === "kubectl" && args[0] === "get" && args[1] === "svc") {
        return {
          command: [command, ...args].join(" "),
          exitCode: 0,
          stdout: JSON.stringify({
            metadata: { name: "hello-world-svc" },
            spec: { type: "LoadBalancer", ports: [{ port: 80, targetPort: "http", protocol: "TCP" }] },
            status: { loadBalancer: { ingress: [{ hostname: "abc.elb.amazonaws.com" }] } }
          }),
          stderr: ""
        };
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
