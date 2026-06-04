import { describe, expect, it } from "vitest";
import { classifyCommandFailure } from "../src/failureClassifier.js";

describe("failure classifier", () => {
  it("classifies ROLLBACK_COMPLETE from sam deploy stderr", () => {
    const result = classifyCommandFailure({
      command: "sam deploy --stack-name hello-world-dev-eks",
      exitCode: 1,
      stdout: "",
      stderr: "Stack hello-world-dev-eks is in ROLLBACK_COMPLETE state and can not be updated."
    }, {
      stackName: "hello-world-dev-eks",
      region: "us-east-1",
      stage: "cloudformation_deploy"
    });

    expect(result.failure_stage).toBe("cloudformation_deploy");
    expect(result.root_cause).toContain("ROLLBACK_COMPLETE");
    expect(result.remediation[0]).toContain("delete-stack");
  });

  it("classifies missing credentials", () => {
    const result = classifyCommandFailure({
      command: "aws cloudformation describe-stacks",
      exitCode: 1,
      stdout: "",
      stderr: "Unable to locate credentials"
    }, {
      stackName: "hello-world-dev-eks",
      region: "us-east-1"
    });

    expect(result.failure_stage).toBe("aws_auth");
  });

  it("uses stderr as root cause for kubectl apply failures", () => {
    const result = classifyCommandFailure({
      command: "kubectl apply -f k8s.yaml",
      exitCode: 1,
      stdout: "namespace/hello-world-v5 created",
      stderr: "The Deployment \"hello-world-v5\" is invalid: spec.template.spec.containers[0].ports[0].containerPort: Invalid value: 808080"
    }, { stackName: "hello-world-v5-dev-eks", region: "us-east-1", stage: "kubectl_apply" });

    expect(result.root_cause).toContain("Invalid value: 808080");
    expect(result.root_cause).not.toContain("namespace/hello-world-v5 created");
  });
});
