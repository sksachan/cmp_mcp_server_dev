import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BodhiClient } from "./bodhiClient.js";
import { ArtifactStatusRequestSchema, DeploymentStatusRequestSchema, DeployRequestSchema, ExecuteDeploymentRequestSchema, InfraReportRequestSchema, normalizeDeployRequest } from "./schemas.js";

export function createMcpServer(bodhiClient: BodhiClient): McpServer {
  const server = new McpServer({
    name: "cmp-bodhi-eks-deployer",
    version: "0.1.0"
  });

  const securitySchemes = [{ type: "oauth2", scopes: ["deploy:eks"] }];

  server.registerTool(
    "deploy_hello_world_to_eks",
    {
      title: "Start Hello World EKS Artifact Workflow",
      description:
        "Starts the Bodhi EKS artifact-generation workflow only. Does not create AWS infrastructure. Use get_hello_world_eks_artifact_status to check readiness, then execute_hello_world_eks_deployment to create infrastructure.",
      inputSchema: DeployRequestSchema.shape,
      securitySchemes,
      _meta: { securitySchemes }
    } as Parameters<McpServer["registerTool"]>[1],
    async (input) => toolResponse(await bodhiClient.startHelloWorldDeployment(normalizeDeployRequest(DeployRequestSchema.parse(input))))
  );

  server.registerTool(
    "get_hello_world_eks_artifact_status",
    {
      title: "Get Hello World EKS Artifact Status",
      description:
        "Read-only status check for a Bodhi EKS artifact-generation run. Does not run SAM, AWS CLI, Docker, or kubectl.",
      inputSchema: ArtifactStatusRequestSchema.shape,
      securitySchemes,
      _meta: { securitySchemes }
    } as Parameters<McpServer["registerTool"]>[1],
    async (input) => toolResponse(await bodhiClient.getArtifactStatus(ArtifactStatusRequestSchema.parse(input)))
  );

  server.registerTool(
    "execute_hello_world_eks_deployment",
    {
      title: "Execute Hello World EKS Deployment",
      description:
        "Explicitly executes approved AWS/SAM/kubectl deployment for a completed Bodhi artifact run. Creates or updates AWS infrastructure. Requires confirm_execute=true.",
      inputSchema: ExecuteDeploymentRequestSchema.shape,
      securitySchemes,
      _meta: { securitySchemes }
    } as Parameters<McpServer["registerTool"]>[1],
    async (input) => toolResponse(await bodhiClient.executeHelloWorldDeployment(ExecuteDeploymentRequestSchema.parse(input)))
  );

  server.registerTool(
    "get_hello_world_eks_deployment_status",
    {
      title: "Get Hello World EKS Deployment Status Deprecated",
      description:
        "Deprecated read-only alias for get_hello_world_eks_artifact_status. Does not run SAM, AWS CLI, Docker, or kubectl.",
      inputSchema: DeploymentStatusRequestSchema.shape,
      securitySchemes,
      _meta: { securitySchemes }
    } as Parameters<McpServer["registerTool"]>[1],
    async (input) => toolResponse(await bodhiClient.getDeploymentStatus(DeploymentStatusRequestSchema.parse(input)))
  );

  server.registerTool(
    "get_hello_world_eks_infra_report",
    {
      title: "Get Hello World EKS Infrastructure Report",
      description:
        "Read-only. Discovers CloudFormation, EKS, EC2/VPC, ECR, Kubernetes service/pod details and returns a sanitized infrastructure report with cost estimates. Does not create, update, or delete resources.",
      inputSchema: InfraReportRequestSchema.shape,
      securitySchemes,
      _meta: { securitySchemes }
    } as Parameters<McpServer["registerTool"]>[1],
    async (input) => toolResponse(await bodhiClient.getInfraReport(InfraReportRequestSchema.parse(input)))
  );

  return server;
}

function toolResponse(result: Record<string, unknown>) {
  return {
    structuredContent: result,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(result, null, 2)
      }
    ]
  };
}
