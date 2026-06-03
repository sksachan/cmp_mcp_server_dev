import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BodhiClient } from "./bodhiClient.js";
import { DeployRequestSchema } from "./schemas.js";

export function createMcpServer(bodhiClient: BodhiClient): McpServer {
  const server = new McpServer({
    name: "cmp-bodhi-eks-deployer",
    version: "0.1.0"
  });

  const deployToolOptions = {
    title: "Deploy Hello World to EKS",
    description:
      "Triggers the Bodhi workflow, submits HITL inputs, waits for completion, and returns Hello World EKS deployment details.",
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
      const result = await bodhiClient.deployHelloWorld(request);

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
