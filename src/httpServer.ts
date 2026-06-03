import http, { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { BodhiClient } from "./bodhiClient.js";
import type { Config } from "./config.js";
import { isAuthorized } from "./auth.js";
import { createMcpServer } from "./mcpServer.js";

export function createHttpServer(config: Config): http.Server {
  const bodhiClient = new BodhiClient(config);

  return http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") {
        return json(res, 200, {
          status: "ok",
          service: "cmp-bodhi-eks-deployer"
        });
      }

      if (req.url?.startsWith("/mcp")) {
        if (req.method === "OPTIONS") {
          setCors(res);
          res.writeHead(204);
          return res.end();
        }

        if (!isAuthorized(req, config.mcpSharedSecret)) {
          return json(res, 401, { error: "Unauthorized" });
        }

        return handleMcpRequest(req, res, bodhiClient);
      }

      return json(res, 404, { error: "Not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown server error";
      return json(res, 500, { error: message });
    }
  });
}

async function handleMcpRequest(req: IncomingMessage, res: ServerResponse, bodhiClient: BodhiClient): Promise<void> {
  setCors(res);

  const server = createMcpServer(bodhiClient);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined
  });

  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, await readJsonBody(req));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  if (req.method !== "POST") return undefined;

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return undefined;
  return JSON.parse(raw);
}

function setCors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id, X-MCP-Shared-Secret");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
}

function json(res: ServerResponse, status: number, body: unknown): void {
  setCors(res);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
