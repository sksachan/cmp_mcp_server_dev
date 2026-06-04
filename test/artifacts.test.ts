import { describe, expect, it } from "vitest";
import { normalizeNotes, parseArtifactBundle, validateArtifactBundle } from "../src/artifacts.js";

const validBundle = {
  status: "artifacts_ready",
  deployment_artifacts: [
    {
      type: "cloudformation_template",
      filename: "template.yaml",
      content: "AWSTemplateFormatVersion: '2010-09-09'\nResources: {}\n"
    },
    {
      type: "kubernetes_manifest",
      filename: "k8s.yaml",
      content: "apiVersion: v1\nkind: Namespace\nmetadata:\n  name: hello-world\n"
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
};

describe("artifact validation", () => {
  it("parses and validates a valid bundle", () => {
    const bundle = parseArtifactBundle(JSON.stringify(validBundle));
    expect(bundle).not.toBeNull();
    const validated = validateArtifactBundle(bundle!);
    expect(validated.cloudformationTemplate.filename).toBe("template.yaml");
    expect(validated.kubernetesManifest?.filename).toBe("k8s.yaml");
    expect(validated.metadata.stack_name).toBe("hello-world-dev");
  });

  it("extracts artifact bundles from nested Bodhi node output", () => {
    const bundle = parseArtifactBundle({
      "Infra Build and Deployment Agent": {
        data: {
          result: {
            response: JSON.stringify(validBundle)
          }
        }
      }
    });

    expect(bundle?.status).toBe("artifacts_ready");
    expect(bundle?.deployment_artifacts?.[0].filename).toBe("template.yaml");
  });

  it("rejects invalid JSON", () => {
    expect(() => parseArtifactBundle("{not-json")).toThrow();
  });

  it("rejects path traversal", () => {
    const bundle = parseArtifactBundle({
      ...validBundle,
      deployment_artifacts: [
        {
          type: "cloudformation_template",
          filename: "../template.yaml",
          content: "Resources: {}\n"
        }
      ]
    });
    expect(() => validateArtifactBundle(bundle!)).toThrow(/Unsafe artifact filename/);
  });

  it("rejects unknown artifact type", () => {
    expect(() => parseArtifactBundle({
      ...validBundle,
      deployment_artifacts: [
        {
          type: "shell_script",
          filename: "deploy.sh",
          content: "echo unsafe"
        }
      ]
    })).toThrow();
  });

  it("rejects missing cloudformation template", () => {
    const bundle = parseArtifactBundle({
      ...validBundle,
      deployment_artifacts: [
        {
          type: "kubernetes_manifest",
          filename: "k8s.yaml",
          content: "apiVersion: v1\nkind: Namespace\n"
        }
      ]
    });
    expect(() => validateArtifactBundle(bundle!)).toThrow(/cloudformation_template/);
  });

  it("parses security notes as a string", () => {
    const bundle = parseArtifactBundle({
      ...validBundle,
      security_notes: "No secrets in artifacts"
    });

    expect(bundle?.security_notes).toBe("No secrets in artifacts");
    expect(normalizeNotes(bundle?.security_notes)).toBe("No secrets in artifacts");
  });

  it("parses and normalizes security notes as an object", () => {
    const bundle = parseArtifactBundle({
      ...validBundle,
      security_notes: {
        iam: "least privilege recommended",
        network: ["public load balancer", "private worker nodes"]
      }
    });

    expect(bundle?.security_notes).toEqual({
      iam: "least privilege recommended",
      network: ["public load balancer", "private worker nodes"]
    });
    expect(normalizeNotes(bundle?.security_notes)).toContain("\"iam\": \"least privilege recommended\"");
  });

  it("parses and normalizes security notes as an array", () => {
    const bundle = parseArtifactBundle({
      ...validBundle,
      security_notes: ["Use IRSA", { rbac: "namespace scoped" }]
    });

    expect(bundle?.security_notes).toEqual(["Use IRSA", { rbac: "namespace scoped" }]);
    expect(normalizeNotes(bundle?.security_notes)).toContain("\"Use IRSA\"");
  });

  it("parses and normalizes cost notes as an object", () => {
    const bundle = parseArtifactBundle({
      ...validBundle,
      cost_notes: {
        estimate: "EKS and NAT Gateway dominate POC cost",
        monthly_total_estimate: 138
      }
    });

    expect(bundle?.cost_notes).toEqual({
      estimate: "EKS and NAT Gateway dominate POC cost",
      monthly_total_estimate: 138
    });
    expect(normalizeNotes(bundle?.cost_notes)).toContain("\"monthly_total_estimate\": 138");
  });
});
