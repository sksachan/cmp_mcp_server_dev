import { z } from "zod";

export const DeployRequestSchema = z.object({
  app_name: z.string().trim().min(1).default("hello-world"),
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

export type DeployRequest = z.infer<typeof DeployRequestSchema>;

export const DeploymentResultSchema = z.object({
  status: z.string(),
  run_id: z.string(),
  application_url: z.string().optional(),
  cluster_name: z.string().optional(),
  namespace: z.string().optional(),
  aws_region: z.string().optional(),
  ecr_repository: z.string().optional(),
  load_balancer: z.string().optional(),
  stack_names: z.array(z.string()).optional(),
  estimated_monthly_cost_usd: z.number().optional(),
  logs_summary: z.string().optional(),
  raw_bodhi_result: z.unknown()
});

export type DeploymentResult = z.infer<typeof DeploymentResultSchema>;
