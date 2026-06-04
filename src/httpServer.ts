import http, { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { BodhiClient } from "./bodhiClient.js";
import type { Config } from "./config.js";
import { isAuthorized } from "./auth.js";
import { createMcpServer } from "./mcpServer.js";
import { OAuthService } from "./oauth.js";

export function createHttpServer(config: Config): http.Server {
  const bodhiClient = new BodhiClient(config);
  const oauthService = new OAuthService(config);

  return http.createServer(async (req, res) => {
    try {
      const baseUrl = getBaseUrl(req, config);
      const url = new URL(req.url ?? "/", baseUrl);

      if (req.method === "GET" && url.pathname === "/health") {
        return json(res, 200, {
          status: "ok",
          service: "cmp-bodhi-eks-deployer",
          tool_contract: "eks-deployer-v2-split-tools",
          version: process.env.npm_package_version ?? "0.1.0",
          git_sha: process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.GIT_SHA ?? "unknown",
          build_time: process.env.BUILD_TIME ?? "unknown"
        });
      }

      if (req.method === "GET" && (url.pathname === "/.well-known/oauth-protected-resource" || url.pathname === "/.well-known/oauth-protected-resource/mcp")) {
        return json(res, 200, oauthService.getProtectedResourceMetadata(baseUrl));
      }

      if (req.method === "GET" && (url.pathname === "/.well-known/oauth-authorization-server" || url.pathname === "/.well-known/openid-configuration")) {
        return json(res, 200, oauthService.getAuthorizationServerMetadata(baseUrl));
      }

      if (url.pathname === "/oauth/register" && req.method === "POST") {
        setCors(res);
        return oauthService.registerClient(req, res);
      }

      if (url.pathname === "/oauth/authorize" && (req.method === "GET" || req.method === "POST")) {
        return oauthService.authorize(req, res, baseUrl);
      }

      if (url.pathname === "/oauth/token" && req.method === "POST") {
        setCors(res);
        return oauthService.token(req, res);
      }

      if (url.pathname.startsWith("/mcp")) {
        if (req.method === "OPTIONS") {
          setCors(res);
          res.writeHead(204);
          return res.end();
        }

        if (!isAuthorized(req, config, oauthService, baseUrl)) {
          res.setHeader("WWW-Authenticate", oauthService.challenge(baseUrl));
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

function getBaseUrl(req: IncomingMessage, config: Config): string {
  if (config.publicBaseUrl) return config.publicBaseUrl;
  const proto = headerValue(req.headers["x-forwarded-proto"]) ?? "http";
  const host = headerValue(req.headers["x-forwarded-host"]) ?? headerValue(req.headers.host) ?? "localhost";
  return `${proto.split(",")[0]}://${host.split(",")[0]}`.replace(/\/+$/, "");
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
