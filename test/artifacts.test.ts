import { describe, expect, it } from "vitest";
import { parseArtifactBundle, validateArtifactBundle } from "../src/artifacts.js";

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
});
