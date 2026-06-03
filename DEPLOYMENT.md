# Deployment Handoff

## 1. Bodhi Studio

Upload this workflow JSON:

```text
/Users/shasacha0/Desktop/Slingshot_CMP_Service_workspace/Bodhi_Workflow/workflow-SS_WF_Build_Deploy_v1-8598b371-272b-44ca-b7c9-3ff772e96477.json
```

Workflow IDs expected by the MCP server:

```text
BODHI_WORKFLOW_ID=8598b371-272b-44ca-b7c9-3ff772e96477
BODHI_TASK_ID=9664fd27-c7e6-4595-963e-c04c6ecd59e8
```

Bodhi must have access to the AWS credentials/profile that can run AWS SAM CLI, create or update EKS/ECR/IAM/networking resources, and deploy Kubernetes manifests.

## 2. GitHub

Repository:

```text
sksachan/cmp_mcp_server_dev
```

Recommended upload shape: push the contents of `MCP_Server` as the repository root. That keeps `.github/workflows/ci.yml`, `package.json`, and `railway.json` at the root where GitHub and Railway expect them.

If the whole workspace is pushed instead, set Railway Root Directory to `MCP_Server`, set Railway's custom config file path to `/MCP_Server/railway.json`, and add a root-level GitHub Actions workflow or move `.github/workflows/ci.yml` to the repository root.

Before pushing, run:

```bash
npm ci
npm run build
npm run verify
npm run smoke
```

## 3. Railway

Settings:

```text
Root Directory: empty if MCP_Server contents are repo root; otherwise MCP_Server
Config File: default railway.json if MCP_Server contents are repo root; otherwise /MCP_Server/railway.json
Build Command: npm ci --include=dev && npm run build
Start Command: npm start
Healthcheck Path: /health
Public Networking: Enabled
Deploy Mode: wait for CI / deploy after GitHub checks pass
```

Wait for CI requires a GitHub workflow that runs on `push`. This repository includes `.github/workflows/ci.yml` for that purpose when `MCP_Server` is pushed as the repository root.

Required env vars:

```text
NODE_ENV=production
MCP_SHARED_SECRET=<strong-random-secret>
PUBLIC_BASE_URL=https://<railway-domain>
OAUTH_LOGIN_PASSWORD=<password-you-enter-during-chatgpt-oauth-linking>
OAUTH_ACCESS_TOKEN_TTL_SECONDS=86400
BODHI_API_BASE_URL=https://sapientaiproducts.com/save/api/v1
BODHI_PAT_TOKEN=<real-pat-token>
BODHI_WORKFLOW_ID=8598b371-272b-44ca-b7c9-3ff772e96477
BODHI_TASK_ID=9664fd27-c7e6-4595-963e-c04c6ecd59e8
AWS_ACCOUNT_ID=051370627449
AWS_ACCOUNT_ALIAS=demo
DEFAULT_AWS_REGION=us-east-1
DEFAULT_CLUSTER_NAME=hello-world-demo
DEFAULT_NAMESPACE=hello-world
DEFAULT_BUDGET_LIMIT_USD=100
BODHI_HITL_POLL_INTERVAL_MS=3000
BODHI_RUN_POLL_INTERVAL_MS=20000
BODHI_TIMEOUT_MS=1800000
```

Railway normally provides `PORT`; do not hard-code it unless the Railway project requires it.

## 4. ChatGPT Connector

Connector URL:

```text
https://<railway-domain>/mcp
```

Authentication:

```text
OAuth
```

ChatGPT discovers OAuth metadata from `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`. During linking, enter the `OAUTH_LOGIN_PASSWORD` value in the authorization page. `MCP_SHARED_SECRET` remains supported for non-ChatGPT smoke tests and direct clients that can send headers.

Expected tool:

```text
deploy_hello_world_to_eks
```

Minimum test request:

```json
{
  "app_name": "hello-world",
  "github_repo": "sksachan/cmp_mcp_server_dev",
  "github_branch": "main",
  "aws_account_id": "051370627449",
  "aws_account_alias": "demo",
  "aws_region": "us-east-1",
  "cluster_name": "hello-world-demo",
  "namespace": "hello-world",
  "environment": "dev",
  "budget_limit_usd": 100,
  "confirm_deploy": true
}
```

The same request is available at `examples/deploy-request.json`. Railway env vars are also available at `examples/railway.env.example`.
