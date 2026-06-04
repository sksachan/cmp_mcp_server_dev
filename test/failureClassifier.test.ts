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
});
