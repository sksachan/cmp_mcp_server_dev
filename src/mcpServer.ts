import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BodhiClient } from "./bodhiClient.js";
import { DeploymentStatusRequestSchema, DeployRequestSchema } from "./schemas.js";

export function createMcpServer(bodhiClient: BodhiClient): McpServer {
  const server = new McpServer({
    name: "cmp-bodhi-eks-deployer",
    version: "0.1.0"
  });

  const deployToolOptions = {
    title: "Deploy Hello World to EKS",
    description:
      "Starts the Bodhi EKS artifact-generation workflow and returns a run_id quickly. Before calling, ask the user for deployment_context covering purpose, environment, audience, maturity such as POC/MVP/production, required components, and cost/security constraints. Then call get_hello_world_eks_deployment_status with the returned run_id.",
    inputSchema: DeployRequestSchema.shape,
    securitySchemes: [{ type: "oauth2", scopes: ["deploy:eks"] }],
    _meta: {
      securitySchemes: [{ type: "oauth2", scopes: ["deploy:eks"] }]
    }
  };

  server.registerTool(
    "deploy_hello_world_to_eks",
    deployToolOptions as Parameters<McpServer["registerTool"]>[1],
    async (input) => {
      const request = DeployRequestSchema.parse(input);
      const result = await bodhiClient.startHelloWorldDeployment(request);

      return {
        structuredContent: result,
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2)
          }
        ]
      };
    }
  );

  const statusToolOptions = {
    title: "Get Hello World EKS Deployment Status",
    description:
      "Checks a previously-started Bodhi run. When Bodhi has completed and returned a valid deployment_artifacts JSON bundle, this validates and executes the approved AWS/SAM/kubectl deployment steps on Railway.",
    inputSchema: DeploymentStatusRequestSchema.shape,
    securitySchemes: [{ type: "oauth2", scopes: ["deploy:eks"] }],
    _meta: {
      securitySchemes: [{ type: "oauth2", scopes: ["deploy:eks"] }]
    }
  };

  server.registerTool(
    "get_hello_world_eks_deployment_status",
    statusToolOptions as Parameters<McpServer["registerTool"]>[1],
    async (input) => {
      const request = DeploymentStatusRequestSchema.parse(input);
      const result = await bodhiClient.getDeploymentStatus(request);

      return {
        structuredContent: result,
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2)
          }
        ]
      };
    }
  );

  return server;
}
