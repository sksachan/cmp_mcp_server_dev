import { describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import { isAuthorized } from "../src/auth.js";
import type { Config } from "../src/config.js";
import { OAuthService } from "../src/oauth.js";

function req(headers: Record<string, string | string[] | undefined>): IncomingMessage {
  return { headers } as IncomingMessage;
}

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
  oauthLoginPassword: "oauth-password",
  oauthAccessTokenTtlSeconds: 3600
};

const oauthService = new OAuthService(config);

describe("isAuthorized", () => {
  it("accepts bearer token", () => {
    expect(isAuthorized(req({ authorization: "Bearer secret" }), config, oauthService, "https://mcp.example")).toBe(true);
  });

  it("accepts shared-secret header", () => {
    expect(isAuthorized(req({ "x-mcp-shared-secret": "secret" }), config, oauthService, "https://mcp.example")).toBe(true);
  });

  it("rejects missing or incorrect secret", () => {
    expect(isAuthorized(req({ authorization: "Bearer wrong" }), config, oauthService, "https://mcp.example")).toBe(false);
    expect(isAuthorized(req({}), config, oauthService, "https://mcp.example")).toBe(false);
  });
});
