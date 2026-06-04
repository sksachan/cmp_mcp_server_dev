import { describe, expect, it } from "vitest";
import { DeployRequestSchema, normalizeDeployRequest } from "../src/schemas.js";
import { validateArtifactBundle } from "../src/artifacts.js";
import { identityFromRequest, validateDeploymentIdentity } from "../src/deploymentIdentity.js";

describe("deployment identity", () => {
  it("derives stack_name when omitted", () => {
    const request = normalizeDeployRequest(DeployRequestSchema.parse({
      deployment_context: "Deploy a fresh POC app to dev EKS for an internal demo with cost-conscious defaults.",
      app_name: "hello-world-v5",
      environment: "dev"
    }));

    expect(request.stack_name).toBe("hello-world-v5-dev-eks");
  });

  it("preserves explicit stack_name", () => {
    const request = normalizeDeployRequest(DeployRequestSchema.parse({
      deployment_context: "Deploy a fresh POC app to dev EKS for an internal demo with cost-conscious defaults.",
      app_name: "hello-world-v5",
      stack_name: "custom-stack",
      environment: "dev"
    }));

    expect(request.stack_name).toBe("custom-stack");
  });

  it("detects artifact identity mismatch against requested identity", () => {
    const request = normalizeDeployRequest(DeployRequestSchema.parse({
      deployment_context: "Deploy a fresh POC app to dev EKS for an internal demo with cost-conscious defaults.",
      app_name: "hello-world-v4",
      stack_name: "hello-world-v4-dev-eks",
      cluster_name: "hello-world-demo-v4",
      namespace: "hello-world-v4",
      aws_region: "us-east-1",
      environment: "dev"
    }));
    const artifactBundle = {
      status: "artifacts_ready",
      app_name: "hello-world",
      stack_name: "hello-world-dev-eks",
      cluster_name: "hello-world-demo",
      namespace: "hello-world",
      aws_region: "us-east-1",
      deployment_artifacts: [
        { type: "cloudformation_template" as const, filename: "template.yaml", content: "Resources: {}\n" },
        { type: "kubernetes_manifest" as const, filename: "k8s.yaml", content: "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: hello-world-v4\n" },
        {
          type: "metadata" as const,
          filename: "params.json",
          content: JSON.stringify({
            app_name: "hello-world-v4",
            stack_name: "hello-world-v4-dev-eks",
            cluster_name: "hello-world-demo-v4",
            namespace: "hello-world-v4",
            aws_region: "us-east-1",
            environment: "dev"
          })
        }
      ]
    };
    const validated = validateArtifactBundle(artifactBundle);
    const result = validateDeploymentIdentity({
      artifactBundle,
      validatedBundle: validated,
      requestIdentity: identityFromRequest(request)
    });

    expect(result.ok).toBe(false);
    expect(result.mismatches.some((mismatch) => mismatch.field === "app_name" && mismatch.actual === "hello-world")).toBe(true);
  });
});
