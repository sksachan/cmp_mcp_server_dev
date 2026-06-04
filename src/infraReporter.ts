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

export type DevopsReportProjection = {
  infra_summary: Record<string, unknown>;
  application_endpoint: Record<string, unknown>;
  devops_report: Record<string, unknown>;
  cleanup: Record<string, unknown>;
  warnings: string[];
  cost_estimate: Record<string, unknown>;
  validation_checks: Array<Record<string, unknown>>;
  resource_inventory: Record<string, unknown>;
  load_balancer_diagnostics?: Record<string, unknown>;
};

type StackResource = {
  logical_id?: string;
  physical_id?: string;
  type?: string;
  status?: string;
};

type KubernetesDiscoveryDiagnostics = {
  kubeconfig_updated: boolean;
  attempted_context_cluster: string;
  commands: Array<{ command: string; exitCode: number; stderr_summary?: string }>;
  discovery_status: "success" | "partial" | "failed";
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
    const kubernetes = await this.discoverKubernetes(input, env, warnings, vpcId);
    const service = kubernetes.service as Record<string, unknown> | undefined;
    const applicationUrl = stringValue(service, "application_url");
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
    const internetGateways = await this.readAwsJson("internet gateways", ["ec2", "describe-internet-gateways", "--filters", `Name=attachment.vpc-id,Values=${vpcId}`, "--region", input.region, "--output", "json"], env, warnings);
    const natGateways = await this.readAwsJson("NAT gateways", ["ec2", "describe-nat-gateways", "--filter", `Name=vpc-id,Values=${vpcId}`, "--region", input.region, "--output", "json"], env, warnings);
    const routeTables = await this.readAwsJson("route tables", ["ec2", "describe-route-tables", "--filters", `Name=vpc-id,Values=${vpcId}`, "--region", input.region, "--output", "json"], env, warnings);
    const securityGroups = await this.readAwsJson("security groups", ["ec2", "describe-security-groups", "--filters", `Name=vpc-id,Values=${vpcId}`, "--region", input.region, "--output", "json"], env, warnings);
    const subnetList = Array.isArray(subnets.Subnets) ? subnets.Subnets.map(summarizeSubnet) : [];

    return {
      vpc_id: vpcId,
      vpc_cidr: vpc.Vpcs?.[0]?.CidrBlock,
      public_subnets: subnetList.filter((subnet) => subnet.map_public_ip_on_launch === true),
      private_subnets: subnetList.filter((subnet) => subnet.map_public_ip_on_launch !== true),
      internet_gateway_id: Array.isArray(internetGateways.InternetGateways) ? internetGateways.InternetGateways[0]?.InternetGatewayId : undefined,
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

  private async discoverKubernetes(input: InfraReportInput, env: NodeJS.ProcessEnv, warnings: string[], vpcId?: string): Promise<Record<string, unknown>> {
    const diagnostics: KubernetesDiscoveryDiagnostics = {
      kubeconfig_updated: false,
      attempted_context_cluster: input.clusterName,
      commands: [],
      discovery_status: "failed"
    };
    const kubeconfig = await this.run("aws", ["eks", "update-kubeconfig", "--name", input.clusterName, "--region", input.region], env);
    recordDiscoveryCommand(diagnostics, kubeconfig);
    diagnostics.kubeconfig_updated = kubeconfig.exitCode === 0;
    if (kubeconfig.exitCode !== 0) warnings.push(`Could not update kubeconfig for Kubernetes discovery: ${shortError(kubeconfig)}`);

    const deployment = await this.readKubectlJson("deployment", ["get", "deployment", input.appName, "-n", input.namespace, "-o", "json"], env, warnings, diagnostics)
      || selectSingle(await this.readKubectlJson("deployment by app label", ["get", "deployment", "-n", input.namespace, "-l", `app=${input.appName}`, "-o", "json"], env, warnings, diagnostics))
      || selectSingle(await this.readKubectlJson("deployment by hello-world label", ["get", "deployment", "-n", input.namespace, "-l", "app=hello-world", "-o", "json"], env, warnings, diagnostics))
      || await this.readKubectlJson("deployment fallback", ["get", "deployment", "hello-world", "-n", input.namespace, "-o", "json"], env, warnings, diagnostics)
      || this.warnSingle("deployment", selectSingle(await this.readKubectlJson("single deployment", ["get", "deployment", "-n", input.namespace, "-o", "json"], env, warnings, diagnostics)), warnings)
      || {};
    const service = await this.readKubectlJson("service", ["get", "svc", input.appName, "-n", input.namespace, "-o", "json"], env, warnings, diagnostics)
      || await this.readKubectlJson("service app-svc fallback", ["get", "svc", `${input.appName}-svc`, "-n", input.namespace, "-o", "json"], env, warnings, diagnostics)
      || selectSingle(await this.readKubectlJson("service by app label", ["get", "svc", "-n", input.namespace, "-l", `app=${input.appName}`, "-o", "json"], env, warnings, diagnostics))
      || selectSingle(await this.readKubectlJson("service by hello-world label", ["get", "svc", "-n", input.namespace, "-l", "app=hello-world", "-o", "json"], env, warnings, diagnostics))
      || this.warnSingle("LoadBalancer service", selectSingleLoadBalancer(await this.readKubectlJson("single LoadBalancer service", ["get", "svc", "-n", input.namespace, "-o", "json"], env, warnings, diagnostics)), warnings)
      || {};
    const appPodsData = await this.readKubectlJson("pods by app label", ["get", "pods", "-n", input.namespace, "-l", `app=${input.appName}`, "-o", "json"], env, warnings, diagnostics);
    const selectorLabels = labelSelector(deployment.spec?.selector?.matchLabels);
    const podsData = appPodsData && Array.isArray(appPodsData.items) && appPodsData.items.length > 0
      ? appPodsData
      : selectorLabels
        ? await this.readKubectlJson("pods by deployment selector", ["get", "pods", "-n", input.namespace, "-l", selectorLabels, "-o", "json"], env, warnings, diagnostics)
        : appPodsData;
    const podsDiscovered = Boolean(podsData && Array.isArray(podsData.items));
    const pods = podsDiscovered && podsData ? podsData.items.map(summarizePod) : undefined;
    const hostname = service.status?.loadBalancer?.ingress?.[0]?.hostname;
    const ports = Array.isArray(service.spec?.ports) ? service.spec.ports.map((port: Record<string, unknown>) => ({
      port: port.port,
      targetPort: port.targetPort,
      protocol: port.protocol
    })) : [];
    const loadBalancerDiagnostics = service.spec?.type === "LoadBalancer"
      ? await this.discoverLoadBalancerDiagnostics(input, env, warnings, service, pods ?? [], vpcId)
      : undefined;
    const diagnosticHostname = stringValue(loadBalancerDiagnostics as Record<string, unknown> | undefined, "fallback_hostname");
    const effectiveHostname = hostname ?? diagnosticHostname;
    const hasDeployment = Boolean(deployment.metadata?.name);
    const hasService = Boolean(service.metadata?.name);
    const kubectlSuccesses = [hasDeployment, podsDiscovered, hasService].filter(Boolean).length;
    diagnostics.discovery_status = kubectlSuccesses === 3 && diagnostics.kubeconfig_updated ? "success" : kubectlSuccesses > 0 ? "partial" : "failed";
    return {
      namespace: input.namespace,
      deployment_name: deployment.metadata?.name,
      replicas_desired: deployment.spec?.replicas,
      replicas_available: deployment.status?.availableReplicas,
      image: deployment.spec?.template?.spec?.containers?.[0]?.image,
      pods,
      pods_discovered: podsDiscovered,
      service: {
        name: service.metadata?.name,
        type: service.spec?.type,
        selector: service.spec?.selector,
        hostname: effectiveHostname,
        kubernetes_status_hostname: hostname,
        load_balancer_hostname: effectiveHostname,
        application_url: effectiveHostname ? `http://${effectiveHostname}` : undefined,
        endpoint_status: effectiveHostname ? "ready" : "pending",
        endpoint_source: hostname ? "kubernetes_service_status" : diagnosticHostname ? "aws_elb_discovery" : undefined,
        endpoint_message: effectiveHostname ? undefined : String((loadBalancerDiagnostics as Record<string, unknown> | undefined)?.diagnosis ?? "LoadBalancer hostname not yet assigned. Retry in 2-3 minutes."),
        ports,
        target_ports: ports.map((port: Record<string, unknown>) => port.targetPort).filter(Boolean)
      },
      load_balancer_diagnostics: loadBalancerDiagnostics,
      kubernetes_discovery: diagnostics
    };
  }

  private async discoverLoadBalancerDiagnostics(input: InfraReportInput, env: NodeJS.ProcessEnv, warnings: string[], service: Record<string, any>, pods: Record<string, unknown>[], vpcId?: string): Promise<Record<string, unknown>> {
    const serviceName = String(service.metadata?.name ?? input.appName);
    const describe = await this.run("kubectl", ["describe", "svc", serviceName, "-n", input.namespace], env);
    const eventsData = await this.readKubectlJson("service events", ["get", "events", "-n", input.namespace, "--sort-by=.lastTimestamp", "-o", "json"], env, warnings);
    const endpointsData = await this.readKubectlJson("service endpoints", ["get", "endpoints", serviceName, "-n", input.namespace, "-o", "json"], env, warnings);
    const podsWide = await this.run("kubectl", ["get", "pods", "-n", input.namespace, "-o", "wide", "--show-labels"], env);
    const serviceStatus = await this.readKubectlJson("service status refresh", ["get", "svc", serviceName, "-n", input.namespace, "-o", "json"], env, warnings);
    const classicElb = await this.readAwsJson("classic load balancers", ["elb", "describe-load-balancers", "--region", input.region, "--output", "json"], env, warnings);
    const elbv2 = await this.readAwsJson("ELBv2 load balancers", ["elbv2", "describe-load-balancers", "--region", input.region, "--output", "json"], env, warnings);
    const serviceStatusObject = serviceStatus && Object.keys(serviceStatus).length > 0 ? serviceStatus : service;
    const serviceEvents = summarizeEvents(eventsData ?? {}, serviceName);
    const endpoints = summarizeEndpoints(endpointsData ?? {});
    const awsLoadBalancers = summarizeLoadBalancers(classicElb, elbv2, {
      serviceName,
      namespace: input.namespace,
      vpcId
    });
    const fallbackHostname = serviceStatusObject.status?.loadBalancer?.ingress?.[0]?.hostname
      ?? awsLoadBalancers.find((lb) => typeof lb.dns_name === "string")?.dns_name;
    const diagnosis = diagnoseLoadBalancer({
      hostname: fallbackHostname,
      kubernetesHostname: service.status?.loadBalancer?.ingress?.[0]?.hostname,
      serviceEvents,
      endpoints,
      awsLoadBalancers
    });
    if (!service.status?.loadBalancer?.ingress?.[0]?.hostname && fallbackHostname) {
      warnings.push("AWS load balancer DNS was discovered before Kubernetes service status reported ingress.");
    }
    return {
      service_name: serviceName,
      service_type: service.spec?.type,
      hostname_assigned: Boolean(fallbackHostname),
      fallback_hostname: fallbackHostname,
      endpoint_source: service.status?.loadBalancer?.ingress?.[0]?.hostname ? "kubernetes_service_status" : fallbackHostname ? "aws_elb_discovery" : "pending",
      kubernetes_service_status: {
        load_balancer_ingress: serviceStatusObject.status?.loadBalancer?.ingress ?? [],
        external_ip: serviceStatusObject.spec?.externalIPs?.[0] ?? null,
        ports: Array.isArray(serviceStatusObject.spec?.ports) ? serviceStatusObject.spec.ports.map((port: Record<string, unknown>) => ({
          port: port.port,
          targetPort: port.targetPort,
          protocol: port.protocol
        })) : [],
        annotations: serviceStatusObject.metadata?.annotations ?? {},
        selector: serviceStatusObject.spec?.selector ?? {}
      },
      service_events: serviceEvents,
      endpoints,
      pods: {
        running: pods.filter((pod) => pod.phase === "Running").length,
        ready: pods.filter((pod) => pod.ready === true).length,
        describe_summary: describe.exitCode === 0 ? summarizeText(describe.stdout) : shortError(describe),
        pods_wide_summary: podsWide.exitCode === 0 ? summarizeText(podsWide.stdout) : shortError(podsWide)
      },
      aws_load_balancers: awsLoadBalancers,
      diagnosis
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

  private async readKubectlJson(label: string, args: string[], env: NodeJS.ProcessEnv, warnings: string[], diagnostics?: KubernetesDiscoveryDiagnostics): Promise<Record<string, any> | null> {
    const result = await this.run("kubectl", args, env);
    if (diagnostics) recordDiscoveryCommand(diagnostics, result);
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
    verify_delete_command: `aws cloudformation describe-stacks --stack-name ${stackName} --region ${region}`,
    note: "CloudFormation stack deletion should remove EKS, node group, VPC, NAT Gateway, ECR repository and log group unless deletion policies or external dependencies block deletion."
  };
}

export function buildDevopsReportProjection(report: InfraReport, input: {
  stackName: string;
  region: string;
  appName?: string;
  namespace?: string;
  clusterName?: string;
  awsAccountId?: string;
  budgetTargetUsd?: number;
}): DevopsReportProjection {
  const service = report.kubernetes.service as Record<string, any> | undefined;
  const loadBalancerDiagnostics = report.kubernetes.load_balancer_diagnostics as Record<string, any> | undefined;
  const firstPort = Array.isArray(service?.ports) ? service.ports[0] as Record<string, unknown> | undefined : undefined;
  const endpointStatus = service?.hostname ? "ready" : service?.endpoint_status ?? "pending";
  const applicationUrl = service?.application_url ?? (service?.hostname ? `http://${service.hostname}` : null);
  const eks = report.eks as Record<string, any>;
  const nodegroups = Array.isArray(eks.nodegroups) ? eks.nodegroups as Record<string, any>[] : [];
  const nodegroup = nodegroups[0] ?? {};
  const kubernetes = report.kubernetes as Record<string, any>;
  const pods = Array.isArray(kubernetes.pods) ? kubernetes.pods as Record<string, unknown>[] : [];
  const podsDiscovered = kubernetes.pods_discovered === true;
  const podsRunning = podsDiscovered ? pods.filter((pod) => pod.phase === "Running").length : null;
  const podsReady = podsDiscovered ? pods.filter((pod) => pod.ready === true).length : null;
  const replicasDesired = numberValue(kubernetes.replicas_desired);
  const replicasAvailable = numberValue(kubernetes.replicas_available);
  const rolloutStatus = (replicasDesired ?? 0) > 0 && (replicasAvailable ?? 0) >= (replicasDesired ?? 0) ? "success" : "unknown";
  const networking = report.networking as Record<string, any>;
  const ecr = report.container_registry as Record<string, any>;
  const cleanup = report.cleanup;
  const costEstimate = normalizeTopLevelCost(report.cost_estimate, input.budgetTargetUsd ?? 100);
  const warnings = [
    ...stringArray(report.report_warnings),
    ...stringArray(costEstimate.warnings)
  ];
  const publicSubnets = Array.isArray(networking.public_subnets) ? networking.public_subnets as Record<string, unknown>[] : [];
  const privateSubnets = Array.isArray(networking.private_subnets) ? networking.private_subnets as Record<string, unknown>[] : [];
  const resourceInventory = {
    vpc_id: networking.vpc_id,
    vpc_cidr: networking.vpc_cidr,
    public_subnet_ids: publicSubnets.map((subnet) => subnet.subnet_id).filter(Boolean),
    private_subnet_ids: privateSubnets.map((subnet) => subnet.subnet_id).filter(Boolean),
    nat_gateway_ids: networking.nat_gateway_ids ?? [],
    internet_gateway_id: networking.internet_gateway_id,
    security_group_ids: networking.security_group_ids ?? [],
    nodegroup_name: nodegroup.name,
    node_instance_types: nodegroup.instance_types ?? [],
    ecr_repository_uri: ecr.ecr_repository_uri,
    cloudwatch_log_group: `/aws/eks/${input.clusterName ?? eks.cluster_name}/cluster`
  };
  const validationChecks = [
    { check: "CloudFormation stack", status: report.cloudformation.status === "CREATE_COMPLETE" || report.cloudformation.status === "UPDATE_COMPLETE" ? "pass" : "unknown", detail: report.cloudformation.status },
    { check: "EKS cluster", status: eks.cluster_status === "ACTIVE" ? "pass" : "unknown", detail: eks.cluster_status },
    { check: "EKS node group", status: nodegroup.status === "ACTIVE" ? "pass" : "unknown", detail: nodegroup.status ? `${nodegroup.status}, desired ${nodegroup.desired_size ?? "unknown"}` : undefined },
    { check: "Kubernetes rollout", status: rolloutStatus === "success" ? "pass" : "unknown", detail: kubernetes.deployment_name ? `Deployment ${kubernetes.deployment_name} rollout ${rolloutStatus}` : undefined },
    { check: "LoadBalancer endpoint", status: endpointStatus === "ready" ? "pass" : "pending", detail: endpointStatus === "ready" ? "hostname assigned" : String(loadBalancerDiagnostics?.diagnosis ?? "hostname pending") },
    { check: "Service endpoints", status: numberValue(loadBalancerDiagnostics?.endpoints?.ready_addresses) ? "pass" : "warning", detail: `ready addresses: ${numberValue(loadBalancerDiagnostics?.endpoints?.ready_addresses) ?? "unknown"}` },
    { check: "AWS LoadBalancer discovery", status: endpointStatus === "ready" ? "pass" : loadBalancerDiagnostics?.aws_load_balancers?.length ? "pending" : "fail", detail: loadBalancerDiagnostics?.aws_load_balancers?.length ? `${loadBalancerDiagnostics.aws_load_balancers.length} candidate load balancer(s)` : "no matching AWS load balancer found" }
  ];
  const applicationEndpoint = {
    status: endpointStatus,
    source: service?.endpoint_source ?? (endpointStatus === "ready" ? "kubernetes_service_status" : undefined),
    service_name: service?.name ?? null,
    service_type: service?.type ?? null,
    hostname: service?.hostname ?? null,
    url: applicationUrl,
    port: firstPort?.port ?? null,
    target_port: firstPort?.targetPort ?? null,
    validation_command: applicationUrl ? `curl -I ${applicationUrl}` : null,
    diagnosis: endpointStatus === "ready" ? undefined : loadBalancerDiagnostics?.diagnosis,
    endpoint_message: endpointStatus === "ready" ? undefined : "LoadBalancer hostname not yet assigned. Retry in 2-3 minutes."
  };
  const infraSummary = {
    stack_name: input.stackName,
    cloudformation_status: report.cloudformation.status,
    cluster_name: input.clusterName ?? eks.cluster_name,
    eks_status: eks.cluster_status,
    namespace: input.namespace ?? kubernetes.namespace,
    deployment: kubernetes.deployment_name,
    deployment_rollout_status: rolloutStatus,
    service_name: service?.name ?? null,
    service_type: service?.type ?? null,
    service_hostname: service?.hostname ?? null,
    application_url: applicationUrl,
    endpoint_status: endpointStatus === "ready" ? undefined : endpointStatus,
    endpoint_message: endpointStatus === "ready" ? undefined : "LoadBalancer hostname not yet assigned. Retry in 2-3 minutes.",
    monthly_cost_estimate_usd: costEstimate.monthly_total_estimate,
    cleanup_command: cleanup.delete_stack_command
  };
  const kubernetesSummary = {
    namespace: input.namespace ?? kubernetes.namespace,
    deployment_name: kubernetes.deployment_name,
    deployment_rollout_status: rolloutStatus,
    replicas_desired: replicasDesired,
    replicas_available: replicasAvailable,
    pods_running: podsRunning,
    pods_ready: podsReady,
    pods_not_ready: podsDiscovered ? pods.length - (podsReady ?? 0) : null,
    service_name: service?.name,
    service_type: service?.type,
    service_hostname: service?.hostname,
    application_url: applicationUrl,
    kubernetes_discovery: kubernetes.kubernetes_discovery
  };
  const devopsReport = {
    deployment_status: {
      status: endpointStatus === "ready" && rolloutStatus === "success" ? "deployed" : "deployed_pending_endpoint",
      rollout_status: rolloutStatus,
      endpoint_status: endpointStatus
    },
    application_endpoint: applicationEndpoint,
    load_balancer_diagnostics: loadBalancerDiagnostics,
    aws_identity: {
      account_id: input.awsAccountId,
      region: input.region
    },
    cloudformation: {
      stack_name: input.stackName,
      status: report.cloudformation.status,
      stack_id: report.cloudformation.stack_id
    },
    eks: {
      cluster_name: input.clusterName ?? eks.cluster_name,
      status: eks.cluster_status,
      version: eks.kubernetes_version,
      endpoint: eks.endpoint,
      nodegroup_name: nodegroup.name,
      nodegroup_status: nodegroup.status,
      desired_size: nodegroup.desired_size,
      min_size: nodegroup.min_size,
      max_size: nodegroup.max_size,
      instance_types: nodegroup.instance_types
    },
    kubernetes: kubernetesSummary,
    kubernetes_discovery: kubernetes.kubernetes_discovery,
    networking: {
      vpc_id: networking.vpc_id,
      vpc_cidr: networking.vpc_cidr,
      public_subnet_ids: resourceInventory.public_subnet_ids,
      private_subnet_ids: resourceInventory.private_subnet_ids,
      nat_gateway_ids: resourceInventory.nat_gateway_ids,
      security_group_ids: resourceInventory.security_group_ids
    },
    container_registry: {
      repository_name: ecr.ecr_repository_name,
      repository_uri: ecr.ecr_repository_uri,
      image_mode: ecr.image_mode,
      image_uri: ecr.image_uri
    },
    observability: {
      cloudwatch_log_group: resourceInventory.cloudwatch_log_group
    },
    cost_estimate: costEstimate,
    security_posture: {
      public_endpoint: endpointStatus === "ready",
      service_type: service?.type,
      image_mode: ecr.image_mode,
      notes: ["No credentials, kubeconfig, service account tokens, or Kubernetes secrets are included in this report."]
    },
    cleanup,
    validation_checks: validationChecks,
    warnings,
    recommended_next_actions: endpointStatus === "ready"
      ? ["Validate the endpoint with the provided curl command.", "Delete the stack after the demo to avoid ongoing charges."]
      : ["Retry the infra report in 2-3 minutes for the LoadBalancer hostname.", "Do not consider the endpoint ready until hostname is assigned."]
  };

  return {
    infra_summary: infraSummary,
    application_endpoint: applicationEndpoint,
    devops_report: devopsReport,
    cleanup,
    warnings,
    cost_estimate: costEstimate,
    validation_checks: validationChecks,
    resource_inventory: resourceInventory,
    load_balancer_diagnostics: loadBalancerDiagnostics
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
    ready: podReady(pod),
    node: pod.spec?.nodeName,
    pod_ip: pod.status?.podIP,
    restart_count: restarts
  };
}

function summarizeEvents(eventsData: Record<string, any>, serviceName: string): Array<Record<string, unknown>> {
  const items = Array.isArray(eventsData.items) ? eventsData.items : [];
  return items
    .filter((event) => {
      const involvedName = event.involvedObject?.name;
      const message = String(event.message ?? "");
      return involvedName === serviceName || message.includes(serviceName) || event.involvedObject?.kind === "Service";
    })
    .slice(-8)
    .map((event) => ({
      type: event.type,
      reason: event.reason,
      message: event.message,
      last_timestamp: event.lastTimestamp ?? event.eventTime ?? event.metadata?.creationTimestamp
    }));
}

function summarizeEndpoints(endpointsData: Record<string, any>): Record<string, unknown> {
  const subsets = Array.isArray(endpointsData.subsets) ? endpointsData.subsets : [];
  const ready = subsets.reduce((sum, subset) => sum + (Array.isArray(subset.addresses) ? subset.addresses.length : 0), 0);
  const notReady = subsets.reduce((sum, subset) => sum + (Array.isArray(subset.notReadyAddresses) ? subset.notReadyAddresses.length : 0), 0);
  const ports = subsets.flatMap((subset) => Array.isArray(subset.ports) ? subset.ports.map((port: Record<string, unknown>) => ({
    name: port.name,
    port: port.port,
    protocol: port.protocol
  })) : []);
  return {
    ready_addresses: ready,
    not_ready_addresses: notReady,
    ports
  };
}

function summarizeLoadBalancers(classicElb: Record<string, any>, elbv2: Record<string, any>, filter: { serviceName: string; namespace: string; vpcId?: string }): Array<Record<string, unknown>> {
  const classic = Array.isArray(classicElb.LoadBalancerDescriptions) ? classicElb.LoadBalancerDescriptions.map((lb: Record<string, any>) => ({
    name: lb.LoadBalancerName,
    dns_name: lb.DNSName,
    type: "classic",
    scheme: lb.Scheme,
    state: undefined,
    vpc_id: lb.VPCId,
    availability_zones: lb.AvailabilityZones
  })) : [];
  const v2 = Array.isArray(elbv2.LoadBalancers) ? elbv2.LoadBalancers.map((lb: Record<string, any>) => ({
    name: lb.LoadBalancerName,
    dns_name: lb.DNSName,
    type: lb.Type ?? "unknown",
    scheme: lb.Scheme,
    state: lb.State?.Code,
    vpc_id: lb.VpcId,
    availability_zones: Array.isArray(lb.AvailabilityZones) ? lb.AvailabilityZones.map((az: Record<string, unknown>) => az.ZoneName).filter(Boolean) : []
  })) : [];
  const all = [...classic, ...v2];
  const serviceTokens = [filter.serviceName, filter.namespace, filter.serviceName.replace(/-/g, "")].filter(Boolean).map((value) => String(value).toLowerCase());
  const matches = all.filter((lb) => {
    const name = String(lb.name ?? "").toLowerCase();
    const dns = String(lb.dns_name ?? "").toLowerCase();
    return (filter.vpcId && lb.vpc_id === filter.vpcId)
      || serviceTokens.some((token) => name.includes(token) || dns.includes(token));
  });
  return (matches.length > 0 ? matches : all).slice(0, 5);
}

function diagnoseLoadBalancer(input: {
  hostname?: string;
  kubernetesHostname?: string;
  serviceEvents: Array<Record<string, unknown>>;
  endpoints: Record<string, unknown>;
  awsLoadBalancers: Array<Record<string, unknown>>;
}): string {
  if (input.kubernetesHostname) return "Kubernetes service status has a LoadBalancer hostname.";
  if (input.hostname) return "AWS load balancer exists but Kubernetes service status has not been updated.";
  const eventText = input.serviceEvents.map((event) => `${event.reason ?? ""} ${event.message ?? ""}`).join("\n").toLowerCase();
  if (/(subnet|tag|permission|accessdenied|unauthorized|not authorized|iam)/.test(eventText)) {
    const warning = input.serviceEvents.find((event) => String(event.type).toLowerCase() === "warning") ?? input.serviceEvents[0];
    return `LoadBalancer provisioning is blocked by Kubernetes service event: ${warning?.reason ?? "Warning"} ${warning?.message ?? ""}`.trim();
  }
  const readyAddresses = numberValue(input.endpoints.ready_addresses) ?? 0;
  if (readyAddresses === 0) return "Service has no ready pod endpoints; check pod labels/readiness.";
  if (/(ensuringloadbalancer|creatingloadbalancer|ensuring load balancer|creating load balancer)/.test(eventText)) {
    return "AWS load balancer provisioning still in progress.";
  }
  if (input.awsLoadBalancers.length === 0) return "No AWS load balancer found for service; inspect service events and cloud-controller-manager permissions.";
  return "AWS cloud provider did not assign a load balancer; check subnet tags, IAM permissions, and service annotations.";
}

function labelSelector(labels: unknown): string | undefined {
  if (!labels || typeof labels !== "object" || Array.isArray(labels)) return undefined;
  const entries = Object.entries(labels as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0);
  return entries.length ? entries.map(([key, value]) => `${key}=${value}`).join(",") : undefined;
}

function podReady(pod: Record<string, any>): boolean {
  const conditions = Array.isArray(pod.status?.conditions) ? pod.status.conditions : [];
  return conditions.some((condition: Record<string, unknown>) => condition.type === "Ready" && condition.status === "True");
}

function summarizeText(value: string): string {
  return value.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 12).join("\n").slice(0, 1200);
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

function normalizeTopLevelCost(cost: Record<string, unknown>, budgetTargetUsd: number): Record<string, unknown> {
  const total = numberValue(cost.monthly_total_estimate) ?? 138;
  return {
    currency: cost.currency ?? "USD",
    monthly_total_estimate: total,
    confidence: cost.confidence ?? "medium",
    budget_target_usd: budgetTargetUsd,
    budget_exceeded: total > budgetTargetUsd,
    line_items: Array.isArray(cost.line_items) ? cost.line_items : [
      { service: "Amazon EKS Control Plane", monthly_estimate: 73, notes: "$0.10/hour approximation" },
      { service: "EC2 worker node", monthly_estimate: 15, notes: "1 x t3.small on-demand approximation" },
      { service: "NAT Gateway", monthly_estimate: 32, notes: "Hourly charge only; data processing excluded" },
      { service: "Load Balancer", monthly_estimate: 16, notes: "Approximate low-traffic ELB estimate" },
      { service: "ECR + CloudWatch Logs + EBS", monthly_estimate: 2, notes: "Small POC footprint" }
    ],
    warnings: [
      "Actual cost may exceed estimate due to data transfer and load balancer usage.",
      "EKS control plane and NAT Gateway accrue hourly charges even when idle.",
      "Delete the stack after demo to avoid ongoing charges."
    ]
  };
}

function selectSingle(value: Record<string, any> | null): Record<string, any> | null {
  const items = value?.items;
  return Array.isArray(items) && items.length === 1 ? items[0] : null;
}

function selectSingleLoadBalancer(value: Record<string, any> | null): Record<string, any> | null {
  const items = value?.items;
  if (!Array.isArray(items)) return null;
  const loadBalancers = items.filter((item) => item?.spec?.type === "LoadBalancer");
  return loadBalancers.length === 1 ? loadBalancers[0] : null;
}

function recordDiscoveryCommand(diagnostics: KubernetesDiscoveryDiagnostics, result: CommandResult): void {
  const stderr = result.stderr.trim();
  diagnostics.commands.push({
    command: result.command,
    exitCode: result.exitCode,
    stderr_summary: stderr ? stderr.slice(0, 300) : undefined
  });
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
