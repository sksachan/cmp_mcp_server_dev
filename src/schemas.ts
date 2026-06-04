import { z } from "zod";
import { deriveStackName } from "./deploymentIdentity.js";

export const DeployRequestSchema = z.object({
  deployment_context: z.string().trim().min(20, "Describe the deployment purpose, environment, audience, maturity, and required components before starting infrastructure work."),
  app_name: z.string().trim().min(1).default("hello-world"),
  stack_name: z.string().trim().min(1).optional(),
  github_repo: z.string().trim().min(1).default("sksachan/cmp_mcp_server_dev"),
  github_branch: z.string().trim().min(1).default("main"),
  aws_account_id: z.string().trim().min(1).default(process.env.AWS_ACCOUNT_ID ?? "051370627449"),
  aws_account_alias: z.string().trim().min(1).default(process.env.AWS_ACCOUNT_ALIAS ?? "demo"),
  aws_region: z.string().trim().min(1).default(process.env.DEFAULT_AWS_REGION ?? "us-east-1"),
  cluster_name: z.string().trim().min(1).default(process.env.DEFAULT_CLUSTER_NAME ?? "hello-world-demo"),
  namespace: z.string().trim().min(1).default(process.env.DEFAULT_NAMESPACE ?? "hello-world"),
  environment: z.string().trim().min(1).default("dev"),
  budget_limit_usd: z.coerce.number().positive().default(Number(process.env.DEFAULT_BUDGET_LIMIT_USD ?? 100)),
  confirm_deploy: z.boolean().default(true)
});

type DeployRequestInput = z.infer<typeof DeployRequestSchema>;
export type DeployRequest = Omit<DeployRequestInput, "stack_name"> & { stack_name: string };

export function normalizeDeployRequest(request: DeployRequestInput): DeployRequest {
  return {
    ...request,
    stack_name: request.stack_name ?? deriveStackName(request.app_name, request.environment)
  };
}

export const DeploymentStatusRequestSchema = z.object({
  run_id: z.string().trim().min(1)
});

export type DeploymentStatusRequest = z.infer<typeof DeploymentStatusRequestSchema>;

export const ArtifactStatusRequestSchema = z.object({
  run_id: z.string().trim().min(1)
});

export type ArtifactStatusRequest = z.infer<typeof ArtifactStatusRequestSchema>;

export const ExecuteDeploymentRequestSchema = z.object({
  run_id: z.string().trim().min(1),
  confirm_execute: z.boolean(),
  force_retry: z.boolean().optional().default(false),
  update_existing: z.boolean().optional().default(false),
  identity_confirmation: z.object({
    app_name: z.string().trim().min(1),
    stack_name: z.string().trim().min(1),
    cluster_name: z.string().trim().min(1),
    namespace: z.string().trim().min(1),
    aws_region: z.string().trim().min(1),
    environment: z.string().trim().min(1).optional()
  }).optional()
});

export type ExecuteDeploymentRequest = z.infer<typeof ExecuteDeploymentRequestSchema>;

export const InfraReportRequestSchema = z.object({
  stack_name: z.string().trim().min(1),
  aws_region: z.string().trim().min(1),
  cluster_name: z.string().trim().optional(),
  namespace: z.string().trim().optional(),
  app_name: z.string().trim().optional()
});

export type InfraReportRequest = z.infer<typeof InfraReportRequestSchema>;

export const DeploymentResultSchema = z.object({
  status: z.string(),
  run_id: z.string(),
  app_name: z.string().optional(),
  stack_name: z.string().optional(),
  application_url: z.string().optional(),
  cluster_name: z.string().optional(),
  namespace: z.string().optional(),
  aws_region: z.string().optional(),
  cloudformation_status: z.string().optional(),
  service_hostname: z.string().optional(),
  image_mode: z.string().optional(),
  failure_stage: z.string().optional(),
  root_cause: z.string().optional(),
  remediation: z.array(z.string()).optional(),
  failed_command: z.string().optional(),
  ecr_repository: z.string().optional(),
  load_balancer: z.string().optional(),
  stack_names: z.array(z.string()).optional(),
  artifact_filenames: z.array(z.string()).optional(),
  estimated_monthly_cost_usd: z.number().optional(),
  logs_summary: z.string().optional(),
  deployment_plan: z.array(z.string()).optional(),
  cost_notes: z.string().optional(),
  security_notes: z.string().optional(),
  next_steps: z.array(z.string()).optional(),
  executor_status: z.string().optional(),
  infra_details: z.record(z.unknown()).optional(),
  infra_summary: z.record(z.unknown()).optional(),
  application_endpoint: z.record(z.unknown()).optional(),
  devops_report: z.record(z.unknown()).optional(),
  cleanup: z.record(z.unknown()).optional(),
  warnings: z.array(z.string()).optional(),
  cost_estimate: z.record(z.unknown()).optional(),
  validation_checks: z.array(z.record(z.unknown())).optional(),
  resource_inventory: z.record(z.unknown()).optional(),
  canonical_identity: z.record(z.unknown()).optional(),
  requested_identity: z.record(z.unknown()).optional(),
  artifact_identity: z.record(z.unknown()).optional(),
  identity_findings: z.array(z.record(z.unknown())).optional(),
  identity_mismatches: z.array(z.record(z.unknown())).optional(),
  identity_warnings: z.array(z.string()).optional(),
  request_identity_available: z.boolean().optional(),
  infra_report: z.record(z.unknown()).optional(),
  report_warnings: z.array(z.string()).optional(),
  message: z.string().optional(),
  aws_account_id: z.string().optional(),
  bodhi_run: z.record(z.unknown()).optional(),
  executor_logs: z.array(z.object({
    command: z.string(),
    exitCode: z.number(),
    stdout: z.string(),
    stderr: z.string()
  })).optional()
});

export type DeploymentResult = z.infer<typeof DeploymentResultSchema>;
