import { describe, expect, it } from "vitest";
import { validateArtifactBundle } from "../src/artifacts.js";
import { DeploymentExecutor } from "../src/deploymentExecutor.js";
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
  oauthLoginPassword: "oauth-password",
  oauthAccessTokenTtlSeconds: 3600,
  executorCommandTimeoutMs: 1000,
  requestDedupTtlMs: 1000,
  jobRetentionMs: 60000
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

describe("DeploymentExecutor", () => {
  it("builds the fixed command plan without arbitrary commands", () => {
    const bundle = validateArtifactBundle({
      status: "artifacts_ready",
      deployment_artifacts: [
        {
          type: "cloudformation_template",
          filename: "template.yaml",
          content: "Resources: {}\n"
        },
        {
          type: "kubernetes_manifest",
          filename: "k8s.yaml",
          content: "apiVersion: v1\nkind: Namespace\n"
        },
        {
          type: "metadata",
          filename: "params.json",
          content: JSON.stringify({
            stack_name: "hello-world-dev",
            cluster_name: "hello-world-demo",
            namespace: "hello-world",
            aws_region: "us-east-1"
          })
        }
      ]
    });

    const executor = new DeploymentExecutor(config);
    const plan = executor.buildCommandPlan(bundle, request);

    expect(plan.map((step) => step.command)).toEqual(["sam", "sam", "aws", "kubectl"]);
    expect(plan[1].args).toContain("--no-confirm-changeset");
    expect(plan[3].args).toEqual(["apply", "-n", "hello-world", "-f", "k8s.yaml"]);
  });
});
