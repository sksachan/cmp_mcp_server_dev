import { describe, expect, it } from "vitest";
import { buildDevopsReportProjection, estimateCost, InfraReporter } from "../src/infraReporter.js";
import type { CommandResult } from "../src/deploymentExecutor.js";

describe("InfraReporter", () => {
  it("builds a sanitized infrastructure report from AWS and Kubernetes discovery", async () => {
    const commands: string[] = [];
    const reporter = new InfraReporter(async (command, args) => {
      commands.push([command, ...args].join(" "));
      return jsonCommand(command, args);
    });

    const report = await reporter.buildReport({
      stackName: "hello-world-v2-dev-eks",
      region: "us-east-1",
      appName: "hello-world-v2",
      namespace: "hello-world-v2",
      clusterName: "hello-world-demo-v2",
      imageMode: "public_nginx_unprivileged"
    });

    expect(report.cloudformation.outputs).toMatchObject({
      VpcId: "vpc-123",
      ClusterName: "hello-world-demo-v2",
      ECRRepositoryUri: "051370627449.dkr.ecr.us-east-1.amazonaws.com/hello-world-v2-dev"
    });
    expect(report.networking.vpc_id).toBe("vpc-123");
    expect((report.eks.nodegroups as unknown[])).toHaveLength(1);
    expect(report.container_registry.image_uri).toBe("nginxinc/nginx-unprivileged:alpine");
    expect(report.kubernetes.service).toMatchObject({ hostname: "abc.elb.amazonaws.com" });
    expect(report.cost_estimate).toMatchObject({ currency: "USD", confidence: "medium" });
    const projection = buildDevopsReportProjection(report, {
      stackName: "hello-world-v2-dev-eks",
      region: "us-east-1",
      appName: "hello-world-v2",
      namespace: "hello-world-v2",
      clusterName: "hello-world-demo-v2",
      awsAccountId: "051370627449",
      budgetTargetUsd: 100
    });
    expect(projection.infra_summary).toMatchObject({
      service_hostname: "abc.elb.amazonaws.com",
      application_url: "http://abc.elb.amazonaws.com",
      monthly_cost_estimate_usd: 138,
      cleanup_command: "aws cloudformation delete-stack --stack-name hello-world-v2-dev-eks --region us-east-1"
    });
    expect(projection.application_endpoint).toMatchObject({
      status: "ready",
      url: "http://abc.elb.amazonaws.com",
      port: 80,
      target_port: "http"
    });
    expect(projection.devops_report).toHaveProperty("deployment_status");
    expect(projection.devops_report).toHaveProperty("cloudformation");
    expect(projection.devops_report).toHaveProperty("eks");
    expect(projection.devops_report).toHaveProperty("kubernetes");
    expect(projection.devops_report).toHaveProperty("networking");
    expect(projection.devops_report).toHaveProperty("cost_estimate");
    expect(projection.devops_report).toHaveProperty("cleanup");
    expect(projection.validation_checks.map((check) => check.check)).toEqual([
      "CloudFormation stack",
      "EKS cluster",
      "EKS node group",
      "Kubernetes rollout",
      "LoadBalancer endpoint",
      "Service endpoints",
      "AWS LoadBalancer discovery"
    ]);
    expect(projection.devops_report.kubernetes).toMatchObject({
      pods_running: 1,
      pods_ready: 1
    });
    expect(JSON.stringify(projection)).not.toContain("SecretAccessKey");
    expect(JSON.stringify(report)).not.toContain("SecretAccessKey");
    expect(commands[commands.findIndex((command) => command.includes("kubectl get deployment")) - 1]).toContain("aws eks update-kubeconfig");
    expect(report.kubernetes.kubernetes_discovery).toMatchObject({
      kubeconfig_updated: true,
      attempted_context_cluster: "hello-world-demo-v2",
      discovery_status: "success"
    });
    expect((report.kubernetes.kubernetes_discovery as { commands: unknown[] }).commands.length).toBeGreaterThan(3);
    expect(commands.some((command) => command.includes("sam deploy"))).toBe(false);
    expect(commands.some((command) => command.includes("kubectl apply"))).toBe(false);
  });

  it("returns warnings for partial discovery failures", async () => {
    const reporter = new InfraReporter(async (command, args) => {
      if (command === "aws" && args[0] === "ec2") {
        return result(command, args, 1, "", "AccessDenied");
      }
      return jsonCommand(command, args);
    });

    const report = await reporter.buildReport({
      stackName: "hello-world-v2-dev-eks",
      region: "us-east-1",
      appName: "hello-world-v2",
      namespace: "hello-world-v2",
      clusterName: "hello-world-demo-v2"
    });

    expect(report.report_warnings?.some((warning) => warning.includes("EC2"))).toBe(true);
    expect(report.cloudformation.status).toBe("CREATE_COMPLETE");
  });

  it("surfaces pending endpoint status when LoadBalancer hostname is missing", async () => {
    const reporter = new InfraReporter((command, args) => jsonCommand(command, args, { omitHostname: true }));
    const report = await reporter.buildReport({
      stackName: "hello-world-v2-dev-eks",
      region: "us-east-1",
      appName: "hello-world-v2",
      namespace: "hello-world-v2",
      clusterName: "hello-world-demo-v2"
    });
    const projection = buildDevopsReportProjection(report, {
      stackName: "hello-world-v2-dev-eks",
      region: "us-east-1",
      appName: "hello-world-v2",
      namespace: "hello-world-v2",
      clusterName: "hello-world-demo-v2"
    });

    expect(projection.infra_summary).toMatchObject({
      service_hostname: null,
      application_url: null,
      endpoint_status: "pending"
    });
    expect(projection.application_endpoint).toMatchObject({
      status: "pending",
      hostname: null,
      url: null,
      diagnosis: "AWS load balancer provisioning still in progress."
    });
    expect(projection.load_balancer_diagnostics).toMatchObject({
      service_name: "hello-world-v2",
      hostname_assigned: false,
      diagnosis: "AWS load balancer provisioning still in progress."
    });
  });

  it("uses AWS load balancer DNS as endpoint fallback when Kubernetes status is empty", async () => {
    const reporter = new InfraReporter((command, args) => jsonCommand(command, args, { omitHostname: true, awsLoadBalancerFallback: true }));
    const report = await reporter.buildReport({
      stackName: "hello-world-v2-dev-eks",
      region: "us-east-1",
      appName: "hello-world-v2",
      namespace: "hello-world-v2",
      clusterName: "hello-world-demo-v2"
    });
    const projection = buildDevopsReportProjection(report, {
      stackName: "hello-world-v2-dev-eks",
      region: "us-east-1",
      appName: "hello-world-v2",
      namespace: "hello-world-v2",
      clusterName: "hello-world-demo-v2"
    });

    expect(projection.infra_summary).toMatchObject({
      service_hostname: "aws-lb.elb.amazonaws.com",
      application_url: "http://aws-lb.elb.amazonaws.com",
      endpoint_status: undefined
    });
    expect(projection.application_endpoint).toMatchObject({
      status: "ready",
      source: "aws_elb_discovery",
      hostname: "aws-lb.elb.amazonaws.com",
      url: "http://aws-lb.elb.amazonaws.com"
    });
    expect(projection.load_balancer_diagnostics).toMatchObject({
      diagnosis: "AWS load balancer exists but Kubernetes service status has not been updated."
    });
  });

  it("counts pods using deployment selector when app label returns no pods", async () => {
    const commands: string[] = [];
    const reporter = new InfraReporter((command, args) => {
      commands.push([command, ...args].join(" "));
      return jsonCommand(command, args, { emptyAppPods: true });
    });
    const report = await reporter.buildReport({
      stackName: "hello-world-v2-dev-eks",
      region: "us-east-1",
      appName: "hello-world-v2",
      namespace: "hello-world-v2",
      clusterName: "hello-world-demo-v2"
    });
    const projection = buildDevopsReportProjection(report, {
      stackName: "hello-world-v2-dev-eks",
      region: "us-east-1",
      appName: "hello-world-v2",
      namespace: "hello-world-v2",
      clusterName: "hello-world-demo-v2"
    });

    expect(commands.some((command) => command.includes("kubectl get pods -n hello-world-v2 -l app.kubernetes.io/name=hello-world-v2"))).toBe(true);
    expect(projection.devops_report.kubernetes).toMatchObject({
      pods_running: 1,
      pods_ready: 1,
      pods_not_ready: 0
    });
  });

  it("discovers app-svc fallback service when exact service is absent", async () => {
    const commands: string[] = [];
    const reporter = new InfraReporter((command, args) => {
      commands.push([command, ...args].join(" "));
      return jsonCommand(command, args, { exactServiceMissing: true });
    });
    const report = await reporter.buildReport({
      stackName: "hello-world-v2-dev-eks",
      region: "us-east-1",
      appName: "hello-world-v2",
      namespace: "hello-world-v2",
      clusterName: "hello-world-demo-v2"
    });

    expect(commands.some((command) => command.includes("kubectl get svc hello-world-v2-svc"))).toBe(true);
    expect(report.kubernetes.service).toMatchObject({
      name: "hello-world-v2-svc",
      hostname: "abc.elb.amazonaws.com"
    });
  });

  it("discovers service by app label when exact and app-svc services are absent", async () => {
    const commands: string[] = [];
    const reporter = new InfraReporter((command, args) => {
      commands.push([command, ...args].join(" "));
      return jsonCommand(command, args, { exactServiceMissing: true, appSvcMissing: true });
    });
    const report = await reporter.buildReport({
      stackName: "hello-world-v2-dev-eks",
      region: "us-east-1",
      appName: "hello-world-v2",
      namespace: "hello-world-v2",
      clusterName: "hello-world-demo-v2"
    });

    expect(commands.some((command) => command.includes("kubectl get svc -n hello-world-v2 -l app=hello-world-v2"))).toBe(true);
    expect(report.kubernetes.service).toMatchObject({
      name: "hello-world-v2-label",
      hostname: "abc.elb.amazonaws.com"
    });
  });

  it("discovers the only LoadBalancer service in the namespace with a warning", async () => {
    const reporter = new InfraReporter((command, args) => jsonCommand(command, args, {
      exactServiceMissing: true,
      appSvcMissing: true,
      labelServiceMissing: true,
      singleLoadBalancerFallback: true
    }));
    const report = await reporter.buildReport({
      stackName: "hello-world-v2-dev-eks",
      region: "us-east-1",
      appName: "hello-world-v2",
      namespace: "hello-world-v2",
      clusterName: "hello-world-demo-v2"
    });

    expect(report.kubernetes.service).toMatchObject({
      name: "namespace-lb",
      type: "LoadBalancer",
      hostname: "abc.elb.amazonaws.com"
    });
    expect(report.report_warnings?.some((warning) => warning.includes("LoadBalancer service"))).toBe(true);
  });


  it("returns Kubernetes diagnostics and null pod counts when kubectl discovery fails", async () => {
    const reporter = new InfraReporter((command, args) => {
      if (command === "kubectl") return Promise.resolve(result(command, args, 1, "", "context deadline exceeded"));
      return jsonCommand(command, args);
    });
    const report = await reporter.buildReport({
      stackName: "hello-world-v2-dev-eks",
      region: "us-east-1",
      appName: "hello-world-v2",
      namespace: "hello-world-v2",
      clusterName: "hello-world-demo-v2"
    });
    const projection = buildDevopsReportProjection(report, {
      stackName: "hello-world-v2-dev-eks",
      region: "us-east-1",
      appName: "hello-world-v2",
      namespace: "hello-world-v2",
      clusterName: "hello-world-demo-v2"
    });

    expect(report.kubernetes.kubernetes_discovery).toMatchObject({
      kubeconfig_updated: true,
      discovery_status: "failed"
    });
    expect(projection.devops_report.kubernetes).toMatchObject({
      pods_running: null,
      service_name: undefined,
      service_hostname: undefined
    });
    expect(JSON.stringify(report.kubernetes.kubernetes_discovery)).toContain("context deadline exceeded");
  });

  it("uses realistic POC cost assumptions and warnings", () => {
    const estimate = estimateCost({
      nodegroups: [{ instance_types: ["t3.small"], desired_size: 1 }],
      natGatewayCount: 1,
      hasLoadBalancer: true
    });

    expect(estimate.monthly_total_estimate).toBeGreaterThan(100);
    expect(JSON.stringify(estimate)).toContain("NAT Gateway");
    expect(JSON.stringify(estimate)).toContain("exceed the requested $100");
  });
});

function jsonCommand(command: string, args: string[], options: {
  omitHostname?: boolean;
  exactServiceMissing?: boolean;
  appSvcMissing?: boolean;
  labelServiceMissing?: boolean;
  singleLoadBalancerFallback?: boolean;
  awsLoadBalancerFallback?: boolean;
  emptyAppPods?: boolean;
} = {}): Promise<CommandResult> {
  const key = [command, ...args].join(" ");
  if (key.includes("cloudformation describe-stacks")) {
    return Promise.resolve(result(command, args, 0, JSON.stringify({
      Stacks: [{
        StackId: "arn:aws:cloudformation:us-east-1:051370627449:stack/hello-world-v2-dev-eks/abc",
        StackName: "hello-world-v2-dev-eks",
        StackStatus: "CREATE_COMPLETE",
        CreationTime: "2026-06-04T10:00:00Z",
        LastUpdatedTime: "2026-06-04T10:30:00Z",
        Outputs: [
          { OutputKey: "VpcId", OutputValue: "vpc-123" },
          { OutputKey: "ClusterName", OutputValue: "hello-world-demo-v2" },
          { OutputKey: "ClusterEndpoint", OutputValue: "https://cluster.example" },
          { OutputKey: "ECRRepositoryUri", OutputValue: "051370627449.dkr.ecr.us-east-1.amazonaws.com/hello-world-v2-dev" }
        ]
      }]
    })));
  }
  if (key.includes("cloudformation list-stack-resources")) {
    return Promise.resolve(result(command, args, 0, JSON.stringify({
      StackResourceSummaries: [
        { LogicalResourceId: "VPC", PhysicalResourceId: "vpc-123", ResourceType: "AWS::EC2::VPC", ResourceStatus: "CREATE_COMPLETE" },
        { LogicalResourceId: "ECR", PhysicalResourceId: "hello-world-v2-dev", ResourceType: "AWS::ECR::Repository", ResourceStatus: "CREATE_COMPLETE" }
      ]
    })));
  }
  if (key.includes("ec2 describe-vpcs")) return Promise.resolve(result(command, args, 0, JSON.stringify({ Vpcs: [{ VpcId: "vpc-123", CidrBlock: "10.0.0.0/16" }] })));
  if (key.includes("ec2 describe-subnets")) return Promise.resolve(result(command, args, 0, JSON.stringify({ Subnets: [{ SubnetId: "subnet-1", CidrBlock: "10.0.1.0/24", AvailabilityZone: "us-east-1a", MapPublicIpOnLaunch: true, State: "available" }] })));
  if (key.includes("ec2 describe-internet-gateways")) return Promise.resolve(result(command, args, 0, JSON.stringify({ InternetGateways: [{ InternetGatewayId: "igw-123" }] })));
  if (key.includes("ec2 describe-nat-gateways")) return Promise.resolve(result(command, args, 0, JSON.stringify({ NatGateways: [{ NatGatewayId: "nat-123" }] })));
  if (key.includes("ec2 describe-route-tables")) return Promise.resolve(result(command, args, 0, JSON.stringify({ RouteTables: [{ RouteTableId: "rtb-123" }] })));
  if (key.includes("ec2 describe-security-groups")) return Promise.resolve(result(command, args, 0, JSON.stringify({ SecurityGroups: [{ GroupId: "sg-123" }] })));
  if (key.includes("eks describe-cluster")) return Promise.resolve(result(command, args, 0, JSON.stringify({ cluster: { name: "hello-world-demo-v2", arn: "arn:eks", status: "ACTIVE", version: "1.29", endpoint: "https://cluster.example" } })));
  if (key.includes("eks list-nodegroups")) return Promise.resolve(result(command, args, 0, JSON.stringify({ nodegroups: ["ng-1"] })));
  if (key.includes("eks describe-nodegroup")) return Promise.resolve(result(command, args, 0, JSON.stringify({ nodegroup: { nodegroupName: "ng-1", status: "ACTIVE", instanceTypes: ["t3.small"], scalingConfig: { desiredSize: 1, minSize: 1, maxSize: 2 }, subnets: ["subnet-1"], nodeRole: "arn:role" } })));
  if (key.includes("eks update-kubeconfig")) return Promise.resolve(result(command, args, 0, "Updated context", ""));
  if (key.includes("ecr describe-repositories")) return Promise.resolve(result(command, args, 0, JSON.stringify({ repositories: [{ repositoryName: "hello-world-v2-dev", repositoryUri: "051370627449.dkr.ecr.us-east-1.amazonaws.com/hello-world-v2-dev", imageScanningConfiguration: { scanOnPush: true }, encryptionConfiguration: { encryptionType: "AES256" } }] })));
  if (key.includes("ecr describe-images")) return Promise.resolve(result(command, args, 0, JSON.stringify({ imageDetails: [] })));
  if (key.includes("kubectl get deployment")) return Promise.resolve(result(command, args, 0, JSON.stringify({ metadata: { name: "hello-world-v2" }, spec: { replicas: 1, selector: { matchLabels: { "app.kubernetes.io/name": "hello-world-v2" } }, template: { spec: { containers: [{ image: "nginxinc/nginx-unprivileged:alpine" }] } } }, status: { availableReplicas: 1 } })));
  if (key.includes("kubectl get events")) return Promise.resolve(result(command, args, 0, JSON.stringify({ items: [{ type: "Normal", reason: "EnsuringLoadBalancer", message: "Ensuring load balancer", involvedObject: { kind: "Service", name: "hello-world-v2" }, lastTimestamp: "2026-06-04T10:20:00Z" }] })));
  if (key.includes("kubectl get endpoints")) return Promise.resolve(result(command, args, 0, JSON.stringify({ subsets: [{ addresses: [{ ip: "10.0.1.10" }], ports: [{ name: "http", port: 8080, protocol: "TCP" }] }] })));
  if (key.includes("kubectl get pods -n hello-world-v2 -l app=hello-world-v2") && options.emptyAppPods) return Promise.resolve(result(command, args, 0, JSON.stringify({ items: [] })));
  if (key.includes("kubectl get pods")) return Promise.resolve(result(command, args, 0, JSON.stringify({ items: [{ metadata: { name: "pod-1" }, spec: { nodeName: "node-1" }, status: { phase: "Running", podIP: "10.0.1.10", conditions: [{ type: "Ready", status: "True" }], containerStatuses: [{ restartCount: 0 }] } }] })));
  if (key.includes("kubectl get svc hello-world-v2 ") && options.exactServiceMissing) return Promise.resolve(result(command, args, 1, "", "not found"));
  if (key.includes("kubectl get svc hello-world-v2-svc") && options.appSvcMissing) return Promise.resolve(result(command, args, 1, "", "not found"));
  if (key.includes("kubectl get svc -n hello-world-v2 -l app=hello-world-v2") && options.labelServiceMissing) return Promise.resolve(result(command, args, 0, JSON.stringify({ items: [] })));
  if (key.includes("kubectl get svc -n hello-world-v2 -l app=hello-world-v2")) {
    return Promise.resolve(result(command, args, 0, JSON.stringify({
      items: [{
        metadata: { name: "hello-world-v2-label" },
        spec: { type: "LoadBalancer", selector: { app: "hello-world-v2" }, ports: [{ port: 80, targetPort: "http", protocol: "TCP" }] },
        status: { loadBalancer: { ingress: options.omitHostname ? [] : [{ hostname: "abc.elb.amazonaws.com" }] } }
      }]
    })));
  }
  if (key.includes("kubectl get svc -n hello-world-v2 -o json") && options.singleLoadBalancerFallback) {
    return Promise.resolve(result(command, args, 0, JSON.stringify({
      items: [
        {
          metadata: { name: "internal-service" },
          spec: { type: "ClusterIP", ports: [{ port: 80, targetPort: "http", protocol: "TCP" }] },
          status: {}
        },
        {
          metadata: { name: "namespace-lb" },
          spec: { type: "LoadBalancer", selector: { app: "hello-world-v2" }, ports: [{ port: 80, targetPort: "http", protocol: "TCP" }] },
          status: { loadBalancer: { ingress: [{ hostname: "abc.elb.amazonaws.com" }] } }
        }
      ]
    })));
  }
  if (key.includes("kubectl get svc")) {
    const name = key.includes("hello-world-v2-svc") ? "hello-world-v2-svc" : "hello-world-v2";
    return Promise.resolve(result(command, args, 0, JSON.stringify({
      metadata: { name },
      spec: { type: "LoadBalancer", selector: { app: "hello-world-v2" }, ports: [{ port: 80, targetPort: "http", protocol: "TCP" }] },
      status: { loadBalancer: { ingress: options.omitHostname ? [] : [{ hostname: "abc.elb.amazonaws.com" }] } }
    })));
  }
  if (key.includes("elb describe-load-balancers")) {
    return Promise.resolve(result(command, args, 0, JSON.stringify({
      LoadBalancerDescriptions: options.awsLoadBalancerFallback ? [{
        LoadBalancerName: "k8s-hello-world-v2",
        DNSName: "aws-lb.elb.amazonaws.com",
        Scheme: "internet-facing",
        VPCId: "vpc-123",
        AvailabilityZones: ["us-east-1a"]
      }] : []
    })));
  }
  if (key.includes("elbv2 describe-load-balancers")) {
    return Promise.resolve(result(command, args, 0, JSON.stringify({
      LoadBalancers: []
    })));
  }
  return Promise.resolve(result(command, args, 0, "{}", ""));
}

function result(command: string, args: string[], exitCode: number, stdout: string, stderr = ""): CommandResult {
  return { command: [command, ...args].join(" "), exitCode, stdout, stderr };
}
