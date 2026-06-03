# CMP MCP Server

Remote MCP server for ChatGPT that starts a Bodhi workflow, submits HITL deployment inputs, returns a `run_id` quickly, and exposes a status tool that executes validated EKS deployment artifacts when Bodhi completes.

## Local Development

```bash
npm i
npm run build
npm run verify
npm run smoke
npm run dev
```

Health check:

```bash
curl http://localhost:3000/health
```

MCP endpoint:

```text
http://localhost:3000/mcp
```

For authenticated MCP calls, send either:

```text
Authorization: Bearer <MCP_SHARED_SECRET>
```

or:

```text
X-MCP-Shared-Secret: <MCP_SHARED_SECRET>
```

ChatGPT custom MCP apps should use OAuth, because the app setup UI does not provide custom header configuration. The server exposes OAuth discovery and token endpoints:

```text
/.well-known/oauth-protected-resource
/.well-known/oauth-authorization-server
/oauth/register
/oauth/authorize
/oauth/token
```

For ChatGPT, select OAuth and use:

```text
Server URL: https://<railway-domain>/mcp
OAuth login password: OAUTH_LOGIN_PASSWORD
```

Set `PUBLIC_BASE_URL=https://<railway-domain>` in Railway so OAuth metadata uses the public HTTPS origin.

## Railway

See [DEPLOYMENT.md](./DEPLOYMENT.md) for the full Bodhi, GitHub, Railway, and ChatGPT connector handoff.

Settings:

```text
Root Directory: MCP_Server
Build Command: npm ci --include=dev && npm run build
Start Command: npm start
Healthcheck Path: /health
Public Networking: Enabled
ChatGPT Connector URL: https://<railway-domain>/mcp
Deploy Mode: wait for CI / deploy after GitHub checks pass
```

If you push the contents of `MCP_Server` as the GitHub repository root, leave Railway Root Directory empty. If you push the whole workspace with `MCP_Server` as a subfolder, set Railway Root Directory to `MCP_Server` and set the custom config file path to `/MCP_Server/railway.json`.

Required variables:

```text
NODE_ENV=production
PORT=<Railway-provided>
MCP_SHARED_SECRET=<strong-random-secret>
BODHI_API_BASE_URL=https://sapientaiproducts.com/save/api/v1
BODHI_PAT_TOKEN=<real-pat-token>
BODHI_WORKFLOW_ID=8598b371-272b-44ca-b7c9-3ff772e96477
BODHI_TASK_ID=9664fd27-c7e6-4595-963e-c04c6ecd59e8
AWS_ACCOUNT_ID=051370627449
AWS_ACCOUNT_ALIAS=demo
DEFAULT_AWS_REGION=us-east-1
PUBLIC_BASE_URL=https://<railway-domain>
OAUTH_LOGIN_PASSWORD=<password-you-enter-during-chatgpt-oauth-linking>
AWS_ACCESS_KEY_ID=<aws-access-key-id>
AWS_SECRET_ACCESS_KEY=<aws-secret-access-key>
AWS_REGION=us-east-1
```

Optional polling variables:

```text
BODHI_HITL_POLL_INTERVAL_MS=3000
BODHI_RUN_POLL_INTERVAL_MS=20000
BODHI_TIMEOUT_MS=1800000
BODHI_START_TIMEOUT_MS=90000
REQUEST_DEDUP_TTL_MS=900000
JOB_RETENTION_MS=86400000
DEFAULT_CLUSTER_NAME=hello-world-demo
DEFAULT_NAMESPACE=hello-world
DEFAULT_BUDGET_LIMIT_USD=100
OAUTH_ACCESS_TOKEN_TTL_SECONDS=86400
AWS_SESSION_TOKEN=<optional-session-token>
EXECUTOR_COMMAND_TIMEOUT_MS=900000
```

Railway uses the checked-in `Dockerfile` so the runtime image contains Node 22, AWS CLI, AWS SAM CLI, kubectl, bash, and Python. Bodhi generates deployment artifacts only; this MCP service validates those artifacts and executes fixed AWS/SAM/kubectl commands. Infrastructure is deployed through CloudFormation via `sam validate` and `sam deploy`; Kubernetes manifests are applied only after the CloudFormation stack succeeds.

Before `sam validate`, the executor normalizes generated EKS templates by removing inline `SecurityGroupIngress` sections that reference other security groups from `AWS::EC2::SecurityGroup` resources. Those rules should be standalone `AWS::EC2::SecurityGroupIngress` resources; this avoids CloudFormation circular dependencies during EKS security group creation.

The main tool, `deploy_hello_world_to_eks`, starts the Bodhi workflow and returns a `run_id`. ChatGPT should then call `get_hello_world_eks_deployment_status` with that `run_id`. The deploy tool requires `deployment_context`, so ChatGPT should ask clarifying questions about purpose, environment, audience, POC/MVP/production maturity, required components, and cost/security constraints before starting infrastructure work.
