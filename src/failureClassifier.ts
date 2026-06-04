import type { CommandResult } from "./deploymentExecutor.js";

export type FailureDiagnostic = {
  failure_stage: string;
  root_cause: string;
  remediation: string[];
  failed_command?: string;
};

export function classifyCommandFailure(
  result: CommandResult,
  context: { stackName: string; region: string; stage?: string }
): FailureDiagnostic {
  const text = `${result.stdout}\n${result.stderr}`.toLowerCase();
  const original = `${result.stdout}\n${result.stderr}`;

  if (text.includes("rollback_complete")) {
    return rollbackCompleteDiagnostic(context.stackName, context.region, context.stage ?? "cloudformation_deploy", result.command);
  }

  if (text.includes("unable to locate credentials") || text.includes("nocredentialproviders")) {
    return {
      failure_stage: "aws_auth",
      root_cause: "AWS credentials are not available to the Railway runtime.",
      remediation: [
        "Verify AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and AWS_REGION/AWS_DEFAULT_REGION are set in Railway.",
        "Verify the Railway service has access to the intended AWS account."
      ],
      failed_command: result.command
    };
  }

  if (text.includes("accessdenied") || text.includes("not authorized")) {
    return {
      failure_stage: "aws_iam",
      root_cause: "The AWS identity used by Railway does not have sufficient IAM permissions.",
      remediation: [
        "Grant CloudFormation, IAM, EKS, EC2/VPC, ECR, CloudWatch Logs, and ELB permissions required for this POC.",
        "Re-run after IAM policy update."
      ],
      failed_command: result.command
    };
  }

  if (text.includes("alreadyexistsexception") || text.includes("alreadyexists")) {
    return {
      failure_stage: "aws_resource_conflict",
      root_cause: "One or more AWS resources already exist with the requested names.",
      remediation: [
        "Use unique app_name/cluster_name/namespace.",
        "Or delete the conflicting resource."
      ],
      failed_command: result.command
    };
  }

  return {
    failure_stage: context.stage ?? "command_execution",
    root_cause: firstNonEmptyLine(original) ?? `Command failed: ${result.command}`,
    remediation: ["Review the failed command output and rerun after correcting the reported issue."],
    failed_command: result.command
  };
}

export function rollbackCompleteDiagnostic(stackName: string, region: string, stage = "cloudformation_preflight", failedCommand?: string): FailureDiagnostic {
  return {
    failure_stage: stage,
    root_cause: `CloudFormation stack ${stackName} is in ROLLBACK_COMPLETE and cannot be updated.`,
    remediation: [
      `aws cloudformation delete-stack --stack-name ${stackName} --region ${region}`,
      `aws cloudformation wait stack-delete-complete --stack-name ${stackName} --region ${region}`,
      "Rerun deployment, or use a new app_name/stack_name."
    ],
    failed_command: failedCommand
  };
}

function firstNonEmptyLine(value: string): string | undefined {
  return value.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
}
