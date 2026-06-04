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
  bodhiStartTimeoutMs: 1000,
  publicBaseUrl: "https://mcp.example",
  oauthLoginPassword: "oauth-password",
  oauthAccessTokenTtlSeconds: 3600,
  executorCommandTimeoutMs: 1000,
  requestDedupTtlMs: 1000,
  jobRetentionMs: 60000,
  usePublicHelloWorldImage: true
};

const request: DeployRequest = {
  deployment_context: "Purpose: POC validation. Environment: dev. Audience: personal demo. Maturity: MVP. Components: minimal EKS app with cost-conscious defaults.",
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

  it("creates run and submits HITL inputs without waiting for completion", async () => {
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

    expect(result.status).toBe("started");
    expect(result.run_id).toBe("run-1");
    expect(result.stack_name).toBe("hello-world-dev-eks");
    expect(calls.some((call) => call.url.endsWith("/tasks/task-id/runs"))).toBe(true);
    expect(calls.some((call) => call.url.endsWith("/tasks/task-id/runs/run-1"))).toBe(false);
  });

  it("starts a run without waiting for Bodhi completion", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(url), init });

      if (String(url).endsWith("/tasks/task-id/runs") && init?.method === "POST") {
        return json({ id: "run-started" });
      }

      if (String(url).endsWith("/tasks/runs/run-started/hitltasks") && init?.method !== "POST") {
        return json({
          hitltasks: [
            {
              id: "hitl-request",
              status: "pending"
            }
          ]
        });
      }

      if (String(url).endsWith("/tasks/runs/run-started/hitltasks") && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        expect(body.hitltasks[0].response.deployment_context).toContain("POC validation");
        return json({ ok: true });
      }

      return json({ error: "unexpected" }, 404);
    };

    const client = new BodhiClient(config, fetchImpl as typeof fetch);
    const result = await client.startHelloWorldDeployment(request);

    expect(result.status).toBe("started");
    expect(result.run_id).toBe("run-started");
    expect(calls.some((call) => call.url.endsWith("/tasks/task-id/runs/run-started"))).toBe(false);
  });

  it("deduplicates matching in-flight deployment starts", async () => {
    let createRunCount = 0;
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (String(url).endsWith("/tasks/task-id/runs") && init?.method === "POST") {
        createRunCount += 1;
        return json({ id: "run-dedup" });
      }

      if (String(url).endsWith("/tasks/runs/run-dedup/hitltasks") && init?.method !== "POST") {
        return json({ hitltasks: [{ id: "hitl-request", status: "pending" }] });
      }

      if (String(url).endsWith("/tasks/runs/run-dedup/hitltasks") && init?.method === "POST") {
        return json({ ok: true });
      }

      return json({ error: "unexpected" }, 404);
    };

    const client = new BodhiClient(config, fetchImpl as typeof fetch);
    const first = await client.startHelloWorldDeployment(request);
    const second = await client.startHelloWorldDeployment(request);

    expect(first.run_id).toBe("run-dedup");
    expect(second.run_id).toBe("run-dedup");
    expect(createRunCount).toBe(1);
  });

  it("returns read-only artifact status and executes only through explicit execute call", async () => {
    let hitlPollCount = 0;
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (String(url).endsWith("/tasks/task-id/runs") && init?.method === "POST") {
        return json({ id: "run-artifacts" });
      }

      if (String(url).endsWith("/tasks/runs/run-artifacts/hitltasks") && init?.method !== "POST") {
        hitlPollCount += 1;
        return json({
          hitltasks: [
            {
              id: hitlPollCount === 1 ? "hitl-request" : "hitl-confirm",
              status: "pending"
            }
          ]
        });
      }

      if (String(url).endsWith("/tasks/runs/run-artifacts/hitltasks") && init?.method === "POST") {
        return json({ ok: true });
      }

      if (String(url).endsWith("/tasks/task-id/runs/run-artifacts")) {
        return json({
          status: "completed",
          result: {
            status: "artifacts_ready",
            deployment_plan: ["Validate", "Deploy"],
            deployment_artifacts: [
              {
                type: "cloudformation_template",
                filename: "template.yaml",
                content: "Resources: {}\n"
              },
              {
                type: "metadata",
                filename: "params.json",
                content: JSON.stringify({
                  stack_name: "hello-world-dev",
                  app_name: "hello-world",
                  cluster_name: "hello-world-demo",
                  namespace: "hello-world",
                  aws_region: "us-east-1",
                  application_url: "https://artifact.example.com"
                })
              }
            ],
            estimated_monthly_cost_usd: 25,
            cost_notes: "Development estimate",
            security_notes: "No secrets in artifacts"
          }
        });
      }

      return json({ error: "unexpected" }, 404);
    };

    const executor = {
      execute: async () => ({
        status: "deployed" as const,
        workspace: "/tmp/workspace",
        application_url: "https://artifact.example.com",
        logs_summary: "OK: sam validate\nOK: sam deploy",
        commands: [
          {
            command: "sam validate --template-file template.yaml",
            exitCode: 0,
            stdout: "valid",
            stderr: ""
          }
        ]
      })
    };

    const client = new BodhiClient(config, fetchImpl as typeof fetch, executor);
    const started = await client.deployHelloWorld(request);
    const status = await client.getArtifactStatus({ run_id: started.run_id });

    expect(status.status).toBe("artifacts_ready");
    expect(status.executor_status).toBeUndefined();
    expect(status.artifact_filenames).toContain("template.yaml");

    const refused = await client.executeHelloWorldDeployment({ run_id: started.run_id, confirm_execute: false, force_retry: false });
    expect(refused.status).toBe("execution_refused");

    const result = await client.executeHelloWorldDeployment({ run_id: started.run_id, confirm_execute: true, force_retry: false });
    expect(result.status).toBe("failed");
    expect(result.failure_stage).toBe("artifact_validation");
  });

  it("sanitizes read-only artifact status and does not call executor", async () => {
    let executorCalls = 0;
    const fetchImpl = async (url: string | URL | Request): Promise<Response> => {
      if (String(url).endsWith("/tasks/task-id/runs/run-ready")) {
        return json({
          id: "run-ready",
          status: "completed",
          access_token: "secret-token",
          exec_metadata: { token: "secret-token" },
          result: {
            status: "artifacts_ready",
            deployment_artifacts: [
              {
                type: "cloudformation_template",
                filename: "template.yaml",
                content: "Resources: {}\n"
              },
              {
                type: "metadata",
                filename: "params.json",
                content: JSON.stringify({
                  app_name: "hello-world",
                  stack_name: "hello-world-dev-eks",
                  cluster_name: "hello-world-demo",
                  namespace: "hello-world",
                  aws_region: "us-east-1"
                })
              }
            ]
          }
        });
      }
      return json({ hitltasks: [] });
    };
    const executor = {
      execute: async () => {
        executorCalls += 1;
        throw new Error("should not execute");
      }
    };

    const client = new BodhiClient(config, fetchImpl as typeof fetch, executor);
    const result = await client.getArtifactStatus({ run_id: "run-ready" });

    expect(result.status).toBe("artifacts_ready");
    expect(executorCalls).toBe(0);
    expect(JSON.stringify(result)).not.toContain("secret-token");
    expect(JSON.stringify(result)).not.toContain("exec_metadata");
  });

  it("normalizes flexible artifact notes for status and execution responses", async () => {
    const fetchImpl = async (url: string | URL | Request): Promise<Response> => {
      if (String(url).endsWith("/tasks/task-id/runs/run-flex-notes")) {
        return json({
          id: "run-flex-notes",
          status: "completed",
          result: {
            status: "artifacts_ready",
            deployment_plan: ["Validate", "Deploy"],
            deployment_artifacts: [
              {
                type: "cloudformation_template",
                filename: "template.yaml",
                content: "Resources: {}\n"
              },
              {
                type: "metadata",
                filename: "params.json",
                content: JSON.stringify({
                  app_name: "hello-world",
                  stack_name: "hello-world-dev-eks",
                  cluster_name: "hello-world-demo",
                  namespace: "hello-world",
                  aws_region: "us-east-1"
                })
              }
            ],
            cost_notes: {
              estimate: "EKS, NAT Gateway, and Load Balancer are the main cost drivers.",
              monthly_total_estimate: 138
            },
            security_notes: [
              "No credentials in generated artifacts.",
              { iam: "Use least privilege permissions for Railway AWS credentials." }
            ]
          }
        });
      }
      return json({ hitltasks: [] });
    };
    const executor = {
      execute: async () => ({
        status: "deployed" as const,
        executor_status: "deployed" as const,
        workspace: "/tmp/workspace",
        stack_name: "hello-world-dev-eks",
        cluster_name: "hello-world-demo",
        namespace: "hello-world",
        app_name: "hello-world",
        aws_region: "us-east-1",
        commands: [],
        logs_summary: "ok"
      })
    };

    const client = new BodhiClient(config, fetchImpl as typeof fetch, executor);
    const status = await client.getArtifactStatus({ run_id: "run-flex-notes" });
    expect(status.status).toBe("artifacts_ready");
    expect(status.cost_notes).toContain("\"monthly_total_estimate\": 138");
    expect(status.security_notes).toContain("No credentials in generated artifacts.");

    const result = await client.executeHelloWorldDeployment({ run_id: "run-flex-notes", confirm_execute: true, force_retry: false });
    expect(result.status).toBe("deployed");
    expect(result.cost_notes).toContain("\"estimate\":");
    expect(result.security_notes).toContain("\"iam\":");
  });

  it("caches terminal execution result by run id", async () => {
    let executorCalls = 0;
    const fetchImpl = async (url: string | URL | Request): Promise<Response> => {
      if (String(url).endsWith("/tasks/task-id/runs/run-execute")) {
        return json({
          id: "run-execute",
          status: "completed",
          result: {
            status: "artifacts_ready",
            deployment_artifacts: [
              {
                type: "cloudformation_template",
                filename: "template.yaml",
                content: "Resources: {}\n"
              },
              {
                type: "metadata",
                filename: "params.json",
                content: JSON.stringify({
                  app_name: "hello-world",
                  stack_name: "hello-world-dev-eks",
                  cluster_name: "hello-world-demo",
                  namespace: "hello-world",
                  aws_region: "us-east-1"
                })
              }
            ]
          }
        });
      }
      return json({ hitltasks: [] });
    };
    const executor = {
      execute: async () => {
        executorCalls += 1;
        return {
          status: "deployed" as const,
          executor_status: "deployed" as const,
          workspace: "/tmp/workspace",
          stack_name: "hello-world-dev-eks",
          cluster_name: "hello-world-demo",
          namespace: "hello-world",
          app_name: "hello-world",
          aws_region: "us-east-1",
          commands: [],
          logs_summary: "ok"
        };
      }
    };

    const client = new BodhiClient(config, fetchImpl as typeof fetch, executor);
    const first = await client.executeHelloWorldDeployment({ run_id: "run-execute", confirm_execute: true, force_retry: false });
    const second = await client.executeHelloWorldDeployment({ run_id: "run-execute", confirm_execute: true, force_retry: false });

    expect(first.status).toBe("deployed");
    expect(second.status).toBe("deployed");
    expect(executorCalls).toBe(1);
  });

  it("reports artifacts_missing when Bodhi returns markdown artifact notes instead of JSON artifacts", async () => {
    const fetchImpl = async (url: string | URL | Request): Promise<Response> => {
      if (String(url).endsWith("/tasks/task-id/runs/run-markdown")) {
        return json({
          status: "completed",
          result: {
            response: "## Deployment Artifacts\nGenerated template.yaml and k8s.yaml. Run sam deploy and kubectl apply manually."
          }
        });
      }

      if (String(url).endsWith("/tasks/runs/run-markdown/hitltasks")) {
        return json({ hitltasks: [] });
      }

      return json({ error: "unexpected" }, 404);
    };

    const client = new BodhiClient(config, fetchImpl as typeof fetch);
    const result = await client.getDeploymentStatus({ run_id: "run-markdown" });

    expect(result.status).toBe("artifacts_missing");
    expect(result.logs_summary).toContain("deployment_artifacts");
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
