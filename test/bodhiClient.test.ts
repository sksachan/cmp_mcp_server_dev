import { describe, expect, it } from "vitest";
import { BodhiClient } from "../src/bodhiClient.js";
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
  publicBaseUrl: "https://mcp.example",
  oauthLoginPassword: "oauth-password",
  oauthAccessTokenTtlSeconds: 3600
};

const request: DeployRequest = {
  app_name: "hello-world",
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

describe("BodhiClient", () => {
  it("does not create a Bodhi run when deployment is not confirmed", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(url), init });
      return json({ error: "should not be called" }, 500);
    };

    const client = new BodhiClient(config, fetchImpl as typeof fetch);
    const result = await client.deployHelloWorld({
      ...request,
      confirm_deploy: false
    });

    expect(result.status).toBe("cancelled");
    expect(result.run_id).toBe("not-created");
    expect(calls).toHaveLength(0);
  });

  it("creates run, submits HITL inputs, and normalizes completion output", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(url), init });

      if (String(url).endsWith("/tasks/task-id/runs") && init?.method === "POST") {
        return json({ id: "run-1" });
      }

      if (String(url).endsWith("/tasks/runs/run-1/hitltasks") && init?.method !== "POST") {
        const hitlCount = calls.filter((call) => call.url.endsWith("/tasks/runs/run-1/hitltasks") && call.init?.method !== "POST").length;
        return json({
          hitltasks: [
            {
              id: hitlCount === 1 ? "hitl-request" : "hitl-confirm",
              status: "pending"
            }
          ]
        });
      }

      if (String(url).endsWith("/tasks/runs/run-1/hitltasks") && init?.method === "POST") {
        return json({ ok: true });
      }

      if (String(url).endsWith("/tasks/task-id/runs/run-1")) {
        return json({
          status: "completed",
          result: {
            application_url: "https://app.example.com",
            ecr_repository: "repo",
            stack_names: ["eks-stack"],
            estimated_monthly_cost_usd: "42"
          }
        });
      }

      return json({ error: "unexpected" }, 404);
    };

    const client = new BodhiClient(config, fetchImpl as typeof fetch);
    const result = await client.deployHelloWorld(request);

    expect(result.status).toBe("completed");
    expect(result.run_id).toBe("run-1");
    expect(result.application_url).toBe("https://app.example.com");
    expect(result.estimated_monthly_cost_usd).toBe(42);
    expect(calls.some((call) => call.url.endsWith("/tasks/task-id/runs"))).toBe(true);
  });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json"
    }
  });
}
