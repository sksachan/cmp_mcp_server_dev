import { tmpdir } from "node:os";
import type { CommandResult, CommandRunner } from "./deploymentExecutor.js";

export interface InfraReportInput {
  stackName: string;
  region: string;
  appName: string;
  namespace: string;
  clusterName: string;
  imageMode?: string;
}

export interface InfraReport {
  summary: Record<string, unknown>;
  cloudformation: Record<string, unknown>;
  networking: Record<string, unknown>;
  eks: Record<string, unknown>;
  container_registry: Record<string, unknown>;
  kubernetes: Record<string, unknown>;
  cost_estimate: Record<string, unknown>;
  cleanup: Record<string, unknown>;
  report_warnings?: string[];
}

type StackResource = {
  logical_id?: string;
  physical_id?: string;
  type?: string;
  status?: string;
};

export class InfraReporter {
  private readonly commandRunner: CommandRunner;
  private readonly timeoutMs: number;

  constructor(commandRunner: CommandRunner, timeoutMs = 60000) {
    this.commandRunner = commandRunner;
    this.timeoutMs = timeoutMs;
  }

  async buildReport(input: InfraReportInput): Promise<InfraReport> {
    const warnings: string[] = [];
    const env = { ...process.env, AWS_REGION: input.region, AWS_DEFAULT_REGION: input.region };

    const stack = await this.discoverStack(input, env, warnings);
    const stackResources = await this.discoverStackResources(input, env, warnings);
    const outputs = stack.outputs as Record<string, string>;
    const vpcId = outputs.VpcId ?? outputs.VPCId ?? findPhysicalId(stackResources, "AWS::EC2::VPC");
    const networking = await this.discoverNetworking(input, env, warnings, vpcId);
    const eks = await this.discoverEks(input, env, warnings);
    const ecr = await this.discoverEcr(input, env, warnings, outputs.ECRRepositoryUri, stackResources);
    const kubernetes = await this.discoverKubernetes(input, env, warnings);
    const service = kubernetes.service as Record<string, unknown> | undefined;
    const applicationUrl = stringValue(service, "hostname") ? `http://${stringValue(service, "hostname")}` : undefined;
    const costEstimate = estimateCost({
      nodegroups: Array.isArray(eks.nodegroups) ? eks.nodegroups as Record<string, unknown>[] : [],
      natGatewayCount: Array.isArray(networking.nat_gateway_ids) ? networking.nat_gateway_ids.length : 0,
      hasLoadBalancer: Boolean(applicationUrl)
    });

    const report: InfraReport = {
      summary: {
        environment: "dev",
        app_name: input.appName,
        deployment_type: "EKS POC",
        cloudformation_status: stack.status,
        kubernetes_rollout_status: availableReplicas(kubernetes) > 0 ? "success" : "unknown",
        public_endpoint: applicationUrl
      },
      cloudformation: {
        stack_name: input.stackName,
        stack_id: stack.stack_id,
        status: stack.status,
        created_time: stack.created_time,
        last_updated_time: stack.last_updated_time,
        outputs,
        resource_summary: stackResources
      },
      networking,
      eks,
      container_registry: {
        ...ecr,
        image_mode: input.imageMode ?? "unknown",
        image_uri: input.imageMode === "public_nginx_unprivileged" ? "nginxinc/nginx-unprivileged:alpine" : ecr.ecr_repository_uri
      },
      kubernetes,
      cost_estimate: costEstimate,
      cleanup: cleanupCommands(input.stackName, input.region)
    };

    if (warnings.length > 0) report.report_warnings = warnings;
    return report;
  }

  private async discoverStack(input: InfraReportInput, env: NodeJS.ProcessEnv, warnings: string[]): Promise<Record<string, unknown> & { outputs: Record<string, string> }> {
    const result = await this.run("aws", ["cloudformation", "describe-stacks", "--stack-name", input.stackName, "--region", input.region, "--output", "json"], env);
    if (result.exitCode !== 0) {
      warnings.push(`Could not retrieve CloudFormation stack: ${shortError(result)}`);
      return { outputs: {} };
    }
    const stack = JSON.parse(result.stdout).Stacks?.[0] ?? {};
    return {
      stack_id: stack.StackId,
      status: stack.StackStatus,
      created_time: stack.CreationTime,
      last_updated_time: stack.LastUpdatedTime,
      outputs: outputMap(stack.Outputs)
    };
  }

  private async discoverStackResources(input: InfraReportInput, env: NodeJS.ProcessEnv, warnings: string[]): Promise<StackResource[]> {
    const result = await this.run("aws", ["cloudformation", "list-stack-resources", "--stack-name", input.stackName, "--region", input.region, "--output", "json"], env);
    if (result.exitCode !== 0) {
      warnings.push(`Could not list CloudFormation resources: ${shortError(result)}`);
      return [];
    }
    const resources = JSON.parse(result.stdout).StackResourceSummaries;
    if (!Array.isArray(resources)) return [];
    return resources.map((item) => ({
      logical_id: item.LogicalResourceId,
      physical_id: item.PhysicalResourceId,
      type: item.ResourceType,
      status: item.ResourceStatus
    }));
  }

  private async discoverNetworking(input: InfraReportInput, env: NodeJS.ProcessEnv, warnings: string[], vpcId?: string): Promise<Record<string, unknown>> {
    if (!vpcId) {
      warnings.push("Could not determine VPC ID from stack outputs or resources.");
      return {};
    }

    const vpc = await this.readAwsJson("EC2 VPC", ["ec2", "describe-vpcs", "--vpc-ids", vpcId, "--region", input.region, "--output", "json"], env, warnings);
    const subnets = await this.readAwsJson("EC2 subnets", ["ec2", "describe-subnets", "--filters", `Name=vpc-id,Values=${vpcId}`, "--region", input.region, "--output", "json"], env, warnings);
    const natGateways = await this.readAwsJson("NAT gateways", ["ec2", "describe-nat-gateways", "--filter", `Name=vpc-id,Values=${vpcId}`, "--region", input.region, "--output", "json"], env, warnings);
    const routeTables = await this.readAwsJson("route tables", ["ec2", "describe-route-tables", "--filters", `Name=vpc-id,Values=${vpcId}`, "--region", input.region, "--output", "json"], env, warnings);
    const securityGroups = await this.readAwsJson("security groups", ["ec2", "describe-security-groups", "--filters", `Name=vpc-id,Values=${vpcId}`, "--region", input.region, "--output", "json"], env, warnings);
    const subnetList = Array.isArray(subnets.Subnets) ? subnets.Subnets.map(summarizeSubnet) : [];

    return {
      vpc_id: vpcId,
      vpc_cidr: vpc.Vpcs?.[0]?.CidrBlock,
      public_subnets: subnetList.filter((subnet) => subnet.map_public_ip_on_launch === true),
      private_subnets: subnetList.filter((subnet) => subnet.map_public_ip_on_launch !== true),
      internet_gateway_id: undefined,
      nat_gateway_ids: Array.isArray(natGateways.NatGateways) ? natGateways.NatGateways.map((item: Record<string, unknown>) => item.NatGatewayId).filter(Boolean) : [],
      route_table_ids: Array.isArray(routeTables.RouteTables) ? routeTables.RouteTables.map((item: Record<string, unknown>) => item.RouteTableId).filter(Boolean) : [],
      security_group_ids: Array.isArray(securityGroups.SecurityGroups) ? securityGroups.SecurityGroups.map((item: Record<string, unknown>) => item.GroupId).filter(Boolean) : []
    };
  }

  private async discoverEks(input: InfraReportInput, env: NodeJS.ProcessEnv, warnings: string[]): Promise<Record<string, unknown>> {
    const clusterData = await this.readAwsJson("EKS cluster", ["eks", "describe-cluster", "--name", input.clusterName, "--region", input.region, "--output", "json"], env, warnings);
    const cluster = clusterData.cluster ?? {};
    const listNodegroups = await this.readAwsJson("EKS nodegroups", ["eks", "list-nodegroups", "--cluster-name", input.clusterName, "--region", input.region, "--output", "json"], env, warnings);
    const nodegroupNames = Array.isArray(listNodegroups.nodegroups) ? listNodegroups.nodegroups : [];
    const nodegroups = [];
    for (const nodegroupName of nodegroupNames) {
      const details = await this.readAwsJson(`EKS nodegroup ${nodegroupName}`, ["eks", "describe-nodegroup", "--cluster-name", input.clusterName, "--nodegroup-name", String(nodegroupName), "--region", input.region, "--output", "json"], env, warnings);
      const ng = details.nodegroup ?? {};
      nodegroups.push({
        name: ng.nodegroupName,
        status: ng.status,
        instance_types: ng.instanceTypes,
        desired_size: ng.scalingConfig?.desiredSize,
        min_size: ng.scalingConfig?.minSize,
        max_size: ng.scalingConfig?.maxSize,
        subnets: ng.subnets,
        node_role_arn: ng.nodeRole
      });
    }
    return {
      cluster_name: cluster.name ?? input.clusterName,
      cluster_arn: cluster.arn,
      cluster_status: cluster.status,
      kubernetes_version: cluster.version,
      endpoint: cluster.endpoint,
      nodegroups
    };
  }

  private async discoverEcr(input: InfraReportInput, env: NodeJS.ProcessEnv, warnings: string[], ecrUri: string | undefined, resources: StackResource[]): Promise<Record<string, unknown>> {
    const repositoryName = ecrUri ? ecrUri.split("/").slice(1).join("/") : repositoryFromResources(resources);
    if (!repositoryName) return {};
    const repoData = await this.readAwsJson("ECR repository", ["ecr", "describe-repositories", "--repository-names", repositoryName, "--region", input.region, "--output", "json"], env, warnings);
    const repo = repoData.repositories?.[0] ?? {};
    const images = await this.readAwsJson("ECR images", ["ecr", "describe-images", "--repository-name", repositoryName, "--region", input.region, "--output", "json"], env, warnings);
    return {
      ecr_repository_name: repositoryName,
      ecr_repository_uri: repo.repositoryUri ?? ecrUri,
      scan_on_push: repo.imageScanningConfiguration?.scanOnPush,
      encryption_type: repo.encryptionConfiguration?.encryptionType,
      image_count: Array.isArray(images.imageDetails) ? images.imageDetails.length : undefined
    };
  }

  private async discoverKubernetes(input: InfraReportInput, env: NodeJS.ProcessEnv, warnings: string[]): Promise<Record<string, unknown>> {
    const deployment = await this.readKubectlJson("deployment", ["get", "deployment", input.appName, "-n", input.namespace, "-o", "json"], env, warnings)
      || await this.readKubectlJson("deployment fallback", ["get", "deployment", "hello-world", "-n", input.namespace, "-o", "json"], env, warnings)
      || selectSingle(await this.readKubectlJson("deployment by app label", ["get", "deployment", "-n", input.namespace, "-l", `app=${input.appName}`, "-o", "json"], env, warnings))
      || selectSingle(await this.readKubectlJson("deployment by hello-world label", ["get", "deployment", "-n", input.namespace, "-l", "app=hello-world", "-o", "json"], env, warnings))
      || this.warnSingle("deployment", selectSingle(await this.readKubectlJson("single deployment", ["get", "deployment", "-n", input.namespace, "-o", "json"], env, warnings)), warnings)
      || {};
    const service = await this.readKubectlJson("service", ["get", "svc", input.appName, "-n", input.namespace, "-o", "json"], env, warnings)
      || await this.readKubectlJson("service app-svc fallback", ["get", "svc", `${input.appName}-svc`, "-n", input.namespace, "-o", "json"], env, warnings)
      || await this.readKubectlJson("service fallback", ["get", "svc", "hello-world-svc", "-n", input.namespace, "-o", "json"], env, warnings)
      || selectSingle(await this.readKubectlJson("service by app label", ["get", "svc", "-n", input.namespace, "-l", `app=${input.appName}`, "-o", "json"], env, warnings))
      || selectSingle(await this.readKubectlJson("service by hello-world label", ["get", "svc", "-n", input.namespace, "-l", "app=hello-world", "-o", "json"], env, warnings))
      || this.warnSingle("service", selectSingle(await this.readKubectlJson("single service", ["get", "svc", "-n", input.namespace, "-o", "json"], env, warnings)), warnings)
      || {};
    const podsData = await this.readKubectlJson("pods", ["get", "pods", "-n", input.namespace, "-o", "json"], env, warnings) || {};
    const pods = Array.isArray(podsData.items) ? podsData.items.map(summarizePod) : [];
    const hostname = service.status?.loadBalancer?.ingress?.[0]?.hostname;
    return {
      namespace: input.namespace,
      deployment_name: deployment.metadata?.name,
      replicas_desired: deployment.spec?.replicas,
      replicas_available: deployment.status?.availableReplicas,
      image: deployment.spec?.template?.spec?.containers?.[0]?.image,
      pods,
      service: {
        name: service.metadata?.name,
        type: service.spec?.type,
        hostname,
        ports: Array.isArray(service.spec?.ports) ? service.spec.ports.map((port: Record<string, unknown>) => ({
          port: port.port,
          targetPort: port.targetPort,
          protocol: port.protocol
        })) : []
      }
    };
  }

  private async readAwsJson(label: string, args: string[], env: NodeJS.ProcessEnv, warnings: string[]): Promise<Record<string, any>> {
    const result = await this.run("aws", args, env);
    if (result.exitCode !== 0) {
      warnings.push(`Could not retrieve ${label}: ${shortError(result)}`);
      return {};
    }
    return parseJsonObject(result.stdout, label, warnings);
  }

  private async readKubectlJson(label: string, args: string[], env: NodeJS.ProcessEnv, warnings: string[]): Promise<Record<string, any> | null> {
    const result = await this.run("kubectl", args, env);
    if (result.exitCode !== 0) return null;
    return parseJsonObject(result.stdout, label, warnings);
  }

  private async run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<CommandResult> {
    return this.commandRunner(command, args, { cwd: tmpdir(), timeoutMs: this.timeoutMs, env });
  }

  private warnSingle(kind: string, value: Record<string, any> | null, warnings: string[]): Record<string, any> | null {
    if (value) warnings.push(`Used only ${kind} in namespace as Kubernetes discovery fallback.`);
    return value;
  }
}

export function estimateCost(input: { nodegroups: Record<string, unknown>[]; natGatewayCount: number; hasLoadBalancer: boolean }): Record<string, unknown> {
  const eks = 73;
  const nodeCount = input.nodegroups.reduce((sum, nodegroup) => sum + (numberValue(nodegroup.desired_size) ?? 1), 0) || 1;
  const instanceType = stringArray(input.nodegroups[0]?.instance_types)[0] ?? "t3.small";
  const ec2 = nodeCount * 15;
  const nat = Math.max(input.natGatewayCount, 1) * 32;
  const lb = input.hasLoadBalancer ? 16 : 16;
  const ecrLogs = 2;
  const total = eks + ec2 + nat + lb + ecrLogs;
  return {
    currency: "USD",
    monthly_total_estimate: total,
    confidence: "medium",
    assumptions: ["730 hours/month", "On-demand pricing approximation", "Low traffic", "Data transfer excluded"],
    line_items: [
      { service: "Amazon EKS Control Plane", quantity: "1 cluster", monthly_estimate: eks, notes: "$0.10/hour approximation" },
      { service: "EC2 worker nodes", quantity: `${nodeCount} x ${instanceType}`, monthly_estimate: ec2, notes: "Approximate on-demand compute only" },
      { service: "NAT Gateway", quantity: `${Math.max(input.natGatewayCount, 1)} gateway`, monthly_estimate: nat, notes: "Hourly charge only; data processing excluded" },
      { service: "Load Balancer", quantity: "1", monthly_estimate: lb, notes: "Approximate low-traffic ELB/NLB estimate" },
      { service: "ECR + CloudWatch Logs", quantity: "low POC usage", monthly_estimate: ecrLogs, notes: "Small image/log footprint" }
    ],
    cost_warnings: [
      "Actual monthly cost may exceed the requested $100 target if the stack is left running continuously.",
      "Delete the stack after demos to stop EKS, NAT Gateway, Load Balancer and EC2 charges.",
      "AWS Free Tier or credits are not included in this estimate."
    ]
  };
}

export function cleanupCommands(stackName: string, region: string): Record<string, string> {
  return {
    delete_stack_command: `aws cloudformation delete-stack --stack-name ${stackName} --region ${region}`,
    wait_delete_command: `aws cloudformation wait stack-delete-complete --stack-name ${stackName} --region ${region}`,
    verify_delete_command: `aws cloudformation describe-stacks --stack-name ${stackName} --region ${region}`
  };
}

function outputMap(outputs: unknown): Record<string, string> {
  const map: Record<string, string> = {};
  if (!Array.isArray(outputs)) return map;
  for (const output of outputs) {
    if (typeof output?.OutputKey === "string" && typeof output?.OutputValue === "string") map[output.OutputKey] = output.OutputValue;
  }
  return map;
}

function summarizeSubnet(subnet: Record<string, any>): Record<string, unknown> {
  return {
    subnet_id: subnet.SubnetId,
    cidr: subnet.CidrBlock,
    availability_zone: subnet.AvailabilityZone,
    map_public_ip_on_launch: subnet.MapPublicIpOnLaunch,
    name: tagName(subnet.Tags),
    state: subnet.State
  };
}

function summarizePod(pod: Record<string, any>): Record<string, unknown> {
  const restarts = Array.isArray(pod.status?.containerStatuses)
    ? pod.status.containerStatuses.reduce((sum: number, status: Record<string, unknown>) => sum + (numberValue(status.restartCount) ?? 0), 0)
    : 0;
  return {
    name: pod.metadata?.name,
    phase: pod.status?.phase,
    node: pod.spec?.nodeName,
    pod_ip: pod.status?.podIP,
    restart_count: restarts
  };
}

function parseJsonObject(value: string, label: string, warnings: string[]): Record<string, any> {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    warnings.push(`Could not parse ${label} JSON response.`);
    return {};
  }
}

function selectSingle(value: Record<string, any> | null): Record<string, any> | null {
  const items = value?.items;
  return Array.isArray(items) && items.length === 1 ? items[0] : null;
}

function availableReplicas(kubernetes: Record<string, unknown>): number {
  return numberValue(kubernetes.replicas_available) ?? 0;
}

function findPhysicalId(resources: StackResource[], type: string): string | undefined {
  return resources.find((resource) => resource.type === type)?.physical_id;
}

function repositoryFromResources(resources: StackResource[]): string | undefined {
  return resources.find((resource) => resource.type === "AWS::ECR::Repository")?.physical_id;
}

function tagName(tags: unknown): string | undefined {
  if (!Array.isArray(tags)) return undefined;
  return tags.find((tag) => tag.Key === "Name")?.Value;
}

function shortError(result: CommandResult): string {
  return (result.stderr || result.stdout || result.command).slice(0, 500);
}

function stringValue(payload: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = payload?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}
